import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { namedVariables, parseConfig, watchConfig } from "./config.ts";

describe("messages.yaml", () => {
  it("reads the example file in config/", () => {
    const c = parseConfig(readFileSync(new URL("../config/messages.yaml", import.meta.url), "utf8"));
    expect(c.providers.email?.primary).toMatchObject({ kind: "ses", region: "eu-central-1", accessKey: "MESSAGES_SES_ACCESS_KEY" });
    expect(c.providers.email?.fallback).toMatchObject({ kind: "smtp", host: "smtp.example.com", port: 587, security: "starttls" });
    expect(c.providers.sms).toMatchObject({ kind: "netgsm", sender: "ACME" });
    expect(c.providers.whatsapp).toMatchObject({ phoneNumberId: "109876543210" });
    expect(c.consent).toEqual({ check: "consent", purpose: "marketing", whatsapp: "sms" });
    expect(c.limits.quietHours).toEqual({ start: 21 * 60, end: 9 * 60, text: "21:00-09:00" });
    expect(namedVariables(c)).toContain("MESSAGES_CONSENT_TOKEN");
  });

  it("has defaults: nothing to send through, and its own opt-out list only when asked", () => {
    const c = parseConfig("consent: { check: own }");
    expect(c.providers).toEqual({ email: null, sms: null, whatsapp: null });
    expect(c.tracking).toEqual({ opens: true, clicks: true, utmSource: "messages" });
    expect(c.limits).toMatchObject({ timezone: "Europe/Istanbul", softBounceTries: 3, phoneCountry: "TR", quietHours: null });
  });

  it("says which field to fix", () => {
    const bad = (yaml: string) => {
      try {
        parseConfig(yaml);
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(bad("")).toMatch(/products.consent needs a token/);
    expect(bad("consent: { check: maybe }")).toMatch(/consent.check/);
    expect(bad("consent: { check: own }\nproviders: { email: { kind: ses, region: eu-central-1 } }")).toMatch(/sender.email/);
    expect(
      bad("consent: { check: own }\nsender: { email: a@example.com }\nproviders: { email: { kind: ses, region: eu-central-1, secret_key: wJalrXUtnFEMI } }"),
    ).toMatch(/providers.email.secret_key is the name of an environment variable/);
    expect(bad("consent: { check: own }\nproviders: { sms: { kind: netgsm, sender: THIS-IS-FAR-TOO-LONG } }")).toMatch(/providers.sms.sender/);
    expect(bad("consent: { check: own }\nproviders: { sms: { kind: twilio } }")).toMatch(/netgsm or iletimerkezi/);
    expect(bad("consent: { check: own }\nproviders: { whatsapp: { phone_number_id: abc } }")).toMatch(/phone_number_id/);
    expect(bad("consent: { check: own }\nlimits: { quiet_hours: 25:00-09:00 }")).toMatch(/quiet_hours/);
    expect(
      bad("consent: { check: own }\nsender: { email: a@example.com }\nproviders: { email: { kind: smtp, host: smtp.example.com, security: none } }"),
    ).toMatch(/security: none/);
    expect(bad("consent: { check: own }\nwho: x")).toMatch(/unknown who/);
    expect(bad("consent: [")).toMatch(/Not valid YAML/);
  });

  it("keeps the last good version when the file on disk has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "messages-config-"));
    const path = join(dir, "messages.yaml");
    writeFileSync(path, "consent: { check: own }\nsender: { name: Acme }");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.sender.name), []), { everyMs: 60_000 });
    writeFileSync(path, "consent: { check: nope }");
    w.read();
    expect(applied).toEqual(["Acme"]);
    expect(w.state.error).toMatch(/consent.check/);
    w.stop();
  });
});
