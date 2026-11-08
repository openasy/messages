// Journeys: messages started by an event, with waits, conditions and channel changes.
//
// - Trigger: an event your app posts to POST /api/v1/events (such as signup), or a person joining an Audience segment,
//   read from the segment's /changes. A person enters a journey once, ever.
// - Steps run in order. send queues one message (keyed by the run and the step, so it is never made twice; consent
//   is asked when it is sent, and a person without consent for that channel is held back there and goes on); wait
//   holds the person for a time; branch tests whether earlier messages were opened or clicked, whether the person has
//   consent for a channel now, or a field, and sends those for whom it does not hold out of the journey or to a later
//   step; exit ends it.
// - A person leaves at once when they convert (the goal: an event, or leaving the trigger's segment) or opt out on
//   any channel.
// - Paused: nobody new enters, and people inside wait at their step until it resumes; their queued messages wait too.
import { CHANNELS, type Channel } from "./config.ts";
import {
  addressOf,
  all,
  hashAddress,
  iso,
  newId,
  one,
  parseJson,
  personKey,
  readPerson,
  run,
  slugify,
  tx,
  type Actor,
  type Core,
  type Person,
} from "./core.ts";
import { bad, conflict, isObj, notFound } from "./errors.ts";
import { audienceChanges, audiencePerson, consentCheck, LinkError } from "./links.ts";
import { consentChannel, type People } from "./people.ts";
import type { Templates } from "./templates.ts";

export type Trigger = { kind: "event"; event: string } | { kind: "segment"; segment: string; name: string };
export type Goal = { kind: "event"; event: string } | { kind: "segment-left" } | null;

export type Step =
  | { id: string; kind: "send"; title: string; channel: Channel; templateId: string }
  | { id: string; kind: "wait"; title: string; minutes: number }
  | {
      id: string;
      kind: "branch";
      title: string;
      test: "opened" | "clicked" | "consent" | "field";
      /** true: it holds when the test does not: "opened neither email?". */
      negate: boolean;
      /** For opened and clicked: the send steps it looks at; all earlier ones by default. */
      steps: string[];
      channel: Channel | null;
      field: string | null;
      value: string | null;
      /** Where the people it does not hold for go: out, or a later step. */
      otherwise: string;
    }
  | { id: string; kind: "exit"; title: string };

interface JourneyRow {
  id: string;
  name: string;
  slug: string;
  state: "draft" | "live" | "paused";
  trigger: string;
  goal: string | null;
  steps: string;
  cursor: string | null;
  problem: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  journey_id: string;
  person_key: string;
  email: string | null;
  phone: string | null;
  user_id: string | null;
  profile: string | null;
  person: string;
  step: number;
  next_at: string;
  state: string;
}

const EVENT = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function createJourneys(core: Core, people: People, templates: Templates) {
  const { db } = core;
  const now = () => iso(core.clock());

  function readSteps(raw: unknown): Step[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) throw bad("steps is a list of 1 to 50 steps.");
    const ids = new Set<string>();
    const steps = raw.map((s, i): Step => {
      const at = `steps[${i}]`;
      if (!isObj(s)) throw bad(`${at} is a step: send, wait, branch or exit.`);
      const id = s.id === undefined ? `s${i + 1}` : s.id;
      if (typeof id !== "string" || !STEP_ID.test(id) || ids.has(id)) throw bad(`${at}.id is a short id of its own, such as welcome-email.`);
      ids.add(id);
      const title = s.title === undefined || s.title === null ? "" : String(s.title).slice(0, 80);
      if (s.kind === "send") {
        if (!CHANNELS.includes(s.channel as Channel)) throw bad(`${at}.channel is email, sms or whatsapp.`);
        const t = typeof s.templateId === "string" ? templates.row(s.templateId) : null;
        if (!t || t.channel !== s.channel) throw bad(`${at}.templateId is a ${String(s.channel)} template.`);
        return { id, kind: "send", title, channel: s.channel as Channel, templateId: t.id };
      }
      if (s.kind === "wait") {
        if (!Number.isInteger(s.minutes) || (s.minutes as number) < 1 || (s.minutes as number) > 525_600) throw bad(`${at}.minutes is 1 to 525,600 (a year).`);
        return { id, kind: "wait", title, minutes: s.minutes as number };
      }
      if (s.kind === "branch") {
        if (!["opened", "clicked", "consent", "field"].includes(s.test as string)) throw bad(`${at}.test is opened, clicked, consent or field.`);
        const test = s.test as "opened" | "clicked" | "consent" | "field";
        const channel = s.channel === undefined || s.channel === null ? null : s.channel;
        if (test === "consent" && !CHANNELS.includes(channel as Channel)) throw bad(`${at}.channel is the channel whose consent is tested.`);
        const field = test === "field" ? s.field : null;
        if (test === "field" && (typeof field !== "string" || !/^[a-z][a-z0-9_]{0,63}$/i.test(field)))
          throw bad(`${at}.field is the personal field to test, such as plan.`);
        const sendIds = s.steps === undefined ? [] : s.steps;
        if (!Array.isArray(sendIds) || sendIds.some((x) => typeof x !== "string")) throw bad(`${at}.steps is a list of earlier send step ids.`);
        const otherwise = s.otherwise ?? "exit";
        if (typeof otherwise !== "string") throw bad(`${at}.otherwise is exit or the id of a later step.`);
        return {
          id,
          kind: "branch",
          title,
          test,
          negate: s.negate === true,
          steps: sendIds as string[],
          channel: channel as Channel | null,
          field: field as string | null,
          value: s.value === undefined || s.value === null ? null : String(s.value),
          otherwise,
        };
      }
      if (s.kind === "exit") return { id, kind: "exit", title };
      throw bad(`${at}.kind is send, wait, branch or exit.`);
    });
    steps.forEach((s, i) => {
      if (s.kind !== "branch") return;
      if (s.otherwise !== "exit" && steps.findIndex((x) => x.id === s.otherwise) <= i) throw bad(`steps[${i}].otherwise is exit or the id of a later step.`);
      for (const id of s.steps)
        if (steps.findIndex((x) => x.id === id && x.kind === "send") < 0 || steps.findIndex((x) => x.id === id) > i)
          throw bad(`steps[${i}].steps names earlier send steps.`);
    });
    return steps;
  }

  function readTrigger(raw: unknown): Trigger {
    if (isObj(raw) && raw.kind === "event" && typeof raw.event === "string" && EVENT.test(raw.event)) return { kind: "event", event: raw.event };
    if (isObj(raw) && raw.kind === "segment" && typeof raw.segment === "string" && raw.segment)
      return { kind: "segment", segment: raw.segment, name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : raw.segment };
    throw bad("trigger is { kind: event, event: signup } or { kind: segment, segment: <Audience segment id>, name }.");
  }

  function readGoal(raw: unknown, trigger: Trigger): Goal {
    if (raw === undefined || raw === null) return null;
    if (isObj(raw) && raw.kind === "event" && typeof raw.event === "string" && EVENT.test(raw.event)) return { kind: "event", event: raw.event };
    if (isObj(raw) && raw.kind === "segment-left") {
      if (trigger.kind !== "segment") throw bad("goal segment-left is for a journey started by a segment.");
      return { kind: "segment-left" };
    }
    throw bad("goal is { kind: event, event: invoice_sent }, { kind: segment-left }, or null.");
  }

  function stats(j: JourneyRow, steps: Step[]) {
    const since = iso(core.clock() - 30 * 86_400_000);
    const entered = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM journey_runs WHERE journey_id = ? AND entered_at >= ?", j.id, since)!.n;
    const converted = one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM journey_runs WHERE journey_id = ? AND state = 'converted' AND left_at >= ?",
      j.id,
      since,
    )!.n;
    const active = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM journey_runs WHERE journey_id = ? AND state = 'active'", j.id)!.n;
    const here = new Map(
      all<{ step: number; n: number }>(db, "SELECT step, COUNT(*) AS n FROM journey_runs WHERE journey_id = ? AND state = 'active' GROUP BY step", j.id).map(
        (r) => [r.step, r.n],
      ),
    );
    const passed = new Map(
      all<{ step_id: string; n: number }>(
        db,
        "SELECT p.step_id, COUNT(*) AS n FROM journey_passes p JOIN journey_runs r ON r.id = p.run_id WHERE r.journey_id = ? AND p.at >= ? GROUP BY p.step_id",
        j.id,
        since,
      ).map((r) => [r.step_id, r.n]),
    );
    const sends = new Map(
      all<{ step_id: string; sent: number; held: number; opened: number; clicked: number }>(
        db,
        `SELECT step_id, COUNT(sent_at) AS sent, SUM(state IN ('held', 'suppressed')) AS held, COUNT(opened_at) AS opened, COUNT(clicked_at) AS clicked
           FROM messages WHERE journey_id = ? AND created_at >= ? GROUP BY step_id`,
        j.id,
        since,
      ).map((r) => [r.step_id, r]),
    );
    return {
      entered,
      converted,
      active,
      steps: steps.map((s, i) => ({
        id: s.id,
        now: here.get(i) ?? 0,
        passed: passed.get(s.id) ?? 0,
        ...(s.kind === "send" && {
          sent: sends.get(s.id)?.sent ?? 0,
          held: sends.get(s.id)?.held ?? 0,
          opened: sends.get(s.id)?.opened ?? 0,
          clicked: sends.get(s.id)?.clicked ?? 0,
        }),
      })),
    };
  }

  function view(j: JourneyRow) {
    const steps = parseJson<Step[]>(j.steps, []);
    return {
      id: j.id,
      name: j.name,
      slug: j.slug,
      utmCampaign: `journey-${j.slug}`,
      state: j.state,
      trigger: parseJson<Trigger>(j.trigger, { kind: "event", event: "" }),
      goal: parseJson<Goal>(j.goal, null),
      steps,
      problem: j.problem,
      stats: stats(j, steps),
      createdBy: j.created_by,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    };
  }

  function get(id: string) {
    const j = one<JourneyRow>(db, "SELECT * FROM journeys WHERE id = ?", id);
    if (!j) throw notFound("The journey");
    return j;
  }

  function uniqueSlug(name: string, except = "") {
    const base = slugify(name);
    let slug = base;
    for (let i = 2; one(db, "SELECT 1 FROM journeys WHERE slug = ? AND id <> ?", slug, except); i++) slug = `${base}-${i}`;
    return slug;
  }

  function create(who: Actor, raw: unknown) {
    if (!isObj(raw)) throw bad("The body is a journey: name, trigger, goal and steps.");
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 120) throw bad("name is 1 to 120 characters.");
    const trigger = readTrigger(raw.trigger);
    const goal = readGoal(raw.goal, trigger);
    const steps = readSteps(raw.steps);
    const id = newId(9);
    run(
      db,
      "INSERT INTO journeys (id, name, slug, state, trigger, goal, steps, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)",
      id,
      raw.name.trim(),
      uniqueSlug(raw.name),
      JSON.stringify(trigger),
      goal && JSON.stringify(goal),
      JSON.stringify(steps),
      who.name,
      now(),
      now(),
    );
    return view(get(id));
  }

  function update(id: string, raw: unknown) {
    const j = get(id);
    if (!isObj(raw)) throw bad("The body has the fields to change: name, trigger, goal and steps.");
    const name = raw.name === undefined ? j.name : raw.name;
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw bad("name is 1 to 120 characters.");
    const changesShape = raw.trigger !== undefined || raw.goal !== undefined || raw.steps !== undefined;
    if (changesShape && j.state !== "draft")
      throw conflict("Only a draft journey's trigger, goal and steps change; people inside a live one are at its steps.");
    const trigger = raw.trigger === undefined ? parseJson<Trigger>(j.trigger, null as unknown as Trigger) : readTrigger(raw.trigger);
    const goal = raw.goal === undefined ? parseJson<Goal>(j.goal, null) : readGoal(raw.goal, trigger);
    const steps = raw.steps === undefined ? parseJson<Step[]>(j.steps, []) : readSteps(raw.steps);
    run(
      db,
      "UPDATE journeys SET name = ?, trigger = ?, goal = ?, steps = ?, cursor = CASE WHEN ? THEN NULL ELSE cursor END, updated_at = ? WHERE id = ?",
      name.trim(),
      JSON.stringify(trigger),
      goal && JSON.stringify(goal),
      JSON.stringify(steps),
      raw.trigger !== undefined ? 1 : 0,
      now(),
      id,
    );
    return view(get(id));
  }

  function setState(id: string, to: "live" | "paused") {
    const j = get(id);
    if (to === "paused" && j.state !== "live") throw conflict("Only a live journey is paused.");
    if (to === "live" && j.state === "live") throw conflict("The journey is live already.");
    run(db, "UPDATE journeys SET state = ?, problem = NULL, updated_at = ? WHERE id = ?", to, now(), id);
    return view(get(id));
  }

  function remove(id: string) {
    const j = get(id);
    if (one(db, "SELECT 1 FROM journey_runs WHERE journey_id = ? LIMIT 1", j.id))
      throw conflict("A journey people have entered is kept with its results; pause it instead.");
    run(db, "DELETE FROM journeys WHERE id = ?", id);
  }

  // ---------------------------------------------------------------- Running

  /** Puts a person into a journey, unless they were in it before. True when they entered. */
  function enter(j: JourneyRow, p: Person): boolean {
    const key = personKey(p);
    if (!key) return false;
    const r = run(
      db,
      `INSERT OR IGNORE INTO journey_runs (id, journey_id, person_key, email, phone, user_id, profile, person, step, next_at, state, entered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)`,
      newId(),
      j.id,
      key,
      p.email,
      p.phone,
      p.userId,
      p.profile,
      JSON.stringify(p),
      now(),
      now(),
    );
    return Number(r.changes) === 1;
  }

  /** Active runs of a journey that are this person, by any identifier. */
  function runsOf(journeyId: string, p: Pick<Person, "email" | "phone" | "userId" | "profile">): RunRow[] {
    const ors: string[] = [];
    const args: string[] = [];
    if (p.email) (ors.push("email = ?"), args.push(p.email));
    if (p.phone) (ors.push("phone = ?"), args.push(p.phone));
    if (p.userId) (ors.push("user_id = ?"), args.push(p.userId));
    if (p.profile) (ors.push("profile = ?"), args.push(p.profile));
    if (!ors.length) return [];
    return all<RunRow>(db, `SELECT * FROM journey_runs WHERE journey_id = ? AND state = 'active' AND (${ors.join(" OR ")})`, journeyId, ...args);
  }

  const convert = (runId: string, reason: string) =>
    run(db, "UPDATE journey_runs SET state = 'converted', reason = ?, left_at = ? WHERE id = ? AND state = 'active'", reason, now(), runId);

  /** Events from your app (POST /api/v1/events): they start journeys and count as their goals. */
  function events(raw: unknown) {
    if (!isObj(raw) || !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 1000)
      throw bad("The body is { events: [...] }, 1 to 1000 events.");
    const country = core.hasConfig() ? core.config().limits.phoneCountry : "TR";
    const read = raw.events.map((e, i) => {
      if (!isObj(e) || typeof e.type !== "string" || !EVENT.test(e.type) || !isObj(e.person))
        throw bad(`events[${i}] is { type, person: { email, phone, userId, name, fields } }.`);
      const p = readPerson(e.person, country);
      if (!personKey(p)) throw bad(`events[${i}].person needs an email, a phone or a userId.`);
      return { type: e.type, person: p };
    });
    const live = all<JourneyRow>(db, "SELECT * FROM journeys WHERE state IN ('live', 'paused')");
    let entered = 0;
    let converted = 0;
    tx(db, () => {
      for (const e of read)
        for (const j of live) {
          const goal = parseJson<Goal>(j.goal, null);
          if (goal?.kind === "event" && goal.event === e.type)
            for (const r of runsOf(j.id, e.person)) converted += Number(convert(r.id, `event:${e.type}`).changes);
          const trigger = parseJson<Trigger>(j.trigger, null as unknown as Trigger);
          if (j.state === "live" && trigger?.kind === "event" && trigger.event === e.type && enter(j, e.person)) entered++;
        }
    });
    return { received: read.length, entered, converted };
  }

  /** Reads who joined and left the segments that start live journeys. The first read only notes where to start. */
  async function pollSegments() {
    if (!core.hasConfig() || !core.links.has("audience")) return;
    for (const j of all<JourneyRow>(db, "SELECT * FROM journeys WHERE state = 'live'")) {
      const trigger = parseJson<Trigger>(j.trigger, null as unknown as Trigger);
      if (trigger?.kind !== "segment") continue;
      const goal = parseJson<Goal>(j.goal, null);
      try {
        const c = core.links.client("audience");
        let cursor = j.cursor;
        const first = cursor === null;
        for (let page = 0; page < 50; page++) {
          const r = await audienceChanges(c, trigger.segment, cursor);
          if (!r) {
            run(db, "UPDATE journeys SET state = 'paused', problem = ? WHERE id = ?", "The segment is no longer in Audience.", j.id);
            break;
          }
          if (!first)
            for (const ch of r.changes) {
              if (ch.change === "joined") {
                const p = await audiencePerson(c, ch.profile);
                if (p) enter(j, { profile: p.id, userId: p.userId, email: p.email, phone: p.phone, name: p.name, fields: p.traits });
              } else if (goal?.kind === "segment-left")
                for (const x of runsOf(j.id, { email: null, phone: null, userId: null, profile: ch.profile })) convert(x.id, "left the segment");
            }
          run(db, "UPDATE journeys SET cursor = ?, problem = NULL WHERE id = ?", r.cursor, j.id);
          if (!r.changes.length || r.cursor === cursor) break;
          cursor = r.cursor;
        }
      } catch (err) {
        if (!(err instanceof LinkError)) throw err;
        run(db, "UPDATE journeys SET problem = ? WHERE id = ?", `Reading the segment: ${err.message}`, j.id);
      }
    }
  }

  /** Whether a branch holds for a run now; null when it cannot be told yet (Consent away). */
  async function holds(s: Extract<Step, { kind: "branch" }>, r: RunRow, steps: Step[], index: number): Promise<boolean | null> {
    let result: boolean;
    if (s.test === "opened" || s.test === "clicked") {
      const ids = s.steps.length
        ? s.steps
        : steps
            .slice(0, index)
            .filter((x) => x.kind === "send")
            .map((x) => x.id);
      const col = s.test === "opened" ? "opened_at" : "clicked_at";
      result = ids.length
        ? !!one(db, `SELECT 1 FROM messages WHERE run_id = ? AND step_id IN (${ids.map(() => "?").join(",")}) AND ${col} IS NOT NULL LIMIT 1`, r.id, ...ids)
        : false;
    } else if (s.test === "consent") {
      const p = parseJson<Person>(r.person, {} as Person);
      const address = addressOf(p, s.channel!);
      if (!address || people.suppressed(s.channel!, address)) result = false;
      else if (core.config().consent.check === "own") result = true;
      else {
        try {
          const [x] = await consentCheck(core.links.client("consent"), core.config().consent.purpose, consentChannel(core, s.channel!), [
            s.channel === "email" ? { email: address } : { phone: address },
          ]);
          result = !!x?.allowed;
        } catch (err) {
          if (err instanceof LinkError) return null;
          throw err;
        }
      }
    } else {
      const v = parseJson<Person>(r.person, {} as Person).fields?.[s.field!];
      result = s.value === null ? v !== undefined && v !== "" : String(v ?? "").toLocaleLowerCase("tr") === s.value.toLocaleLowerCase("tr");
    }
    return s.negate ? !result : result;
  }

  /** Moves one run through its steps until it waits, leaves or ends. */
  async function advance(j: JourneyRow, steps: Step[], r: RunRow) {
    let index = r.step;
    for (let guard = 0; guard < 60; guard++) {
      const s = steps[index];
      if (!s) {
        run(db, "UPDATE journey_runs SET state = 'done', reason = 'end', step = ?, left_at = ? WHERE id = ?", index, now(), r.id);
        return;
      }
      const first = Number(run(db, "INSERT OR IGNORE INTO journey_passes (run_id, step_id, at) VALUES (?, ?, ?)", r.id, s.id, now()).changes) === 1;
      if (s.kind === "send") {
        const p = parseJson<Person>(r.person, {} as Person);
        const address = addressOf(p, s.channel);
        if (address)
          run(
            db,
            `INSERT OR IGNORE INTO messages (id, dedupe, journey_id, run_id, step_id, channel, address, person, template_id, utm_campaign, state, next_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
            newId(),
            `j:${r.id}:${s.id}:${hashAddress(s.channel, address)}`,
            j.id,
            r.id,
            s.id,
            s.channel,
            address,
            r.person,
            s.templateId,
            `journey-${j.slug}`,
            now(),
            now(),
          );
        index++;
      } else if (s.kind === "wait") {
        if (first) {
          run(db, "UPDATE journey_runs SET step = ?, next_at = ? WHERE id = ?", index, iso(core.clock() + s.minutes * 60_000), r.id);
          return;
        }
        index++;
      } else if (s.kind === "branch") {
        const ok = await holds(s, r, steps, index);
        if (ok === null) {
          run(db, "DELETE FROM journey_passes WHERE run_id = ? AND step_id = ?", r.id, s.id);
          run(db, "UPDATE journey_runs SET step = ?, next_at = ? WHERE id = ?", index, iso(core.clock() + 60_000), r.id);
          return;
        }
        if (ok) index++;
        else if (s.otherwise === "exit") {
          run(db, "UPDATE journey_runs SET state = 'exited', reason = ?, step = ?, left_at = ? WHERE id = ?", `branch:${s.id}`, index, now(), r.id);
          return;
        } else index = steps.findIndex((x) => x.id === s.otherwise);
      } else {
        run(db, "UPDATE journey_runs SET state = 'done', reason = 'exit', step = ?, left_at = ? WHERE id = ?", index, now(), r.id);
        return;
      }
      run(db, "UPDATE journey_runs SET step = ?, next_at = ? WHERE id = ?", index, now(), r.id);
    }
  }

  /** Moves every due run of every live journey. */
  async function tick() {
    if (!core.hasConfig()) return;
    const journeys = new Map<string, { j: JourneyRow; steps: Step[] }>();
    for (const r of all<RunRow & { jstate: string }>(
      db,
      "SELECT r.*, j.state AS jstate FROM journey_runs r JOIN journeys j ON j.id = r.journey_id WHERE r.state = 'active' AND j.state = 'live' AND r.next_at <= ? ORDER BY r.next_at LIMIT 500",
      now(),
    )) {
      let x = journeys.get(r.journey_id);
      if (!x) {
        const j = get(r.journey_id);
        x = { j, steps: parseJson<Step[]>(j.steps, []) };
        journeys.set(r.journey_id, x);
      }
      await advance(x.j, x.steps, r);
    }
  }

  return {
    list: () => all<JourneyRow>(db, "SELECT * FROM journeys ORDER BY created_at").map(view),
    get: (id: string) => view(get(id)),
    create,
    update,
    start: (id: string) => setState(id, "live"),
    pause: (id: string) => setState(id, "paused"),
    remove,
    events,
    pollSegments,
    tick,
  };
}

export type Journeys = ReturnType<typeof createJourneys>;
