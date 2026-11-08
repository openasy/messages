# messages

[![CI](https://github.com/openasy/messages/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/messages/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Messages product: email, SMS and WhatsApp campaigns and journeys, sent
through the providers you already pay for (your SMTP server or Amazon SES, Netgsm or İleti Merkezi, the WhatsApp
Business Cloud API) and only to people whose consent holds at the moment each message is sent. It reports what was
delivered, opened and clicked, and its links carry the campaign to Analytics.

```
messages.yaml ──▶ messages ──▶ SES / SMTP, Netgsm / İleti Merkezi, WhatsApp ──▶ people
                   │  ▲  ▲                         │
                   │  │  └── /hooks/: bounces, deliveries, replies, STOP ◀┘
                   │  └───── /o/ /c/ /u/: opens, clicks (tagged for Analytics), unsubscribes
                   ├──▶ Consent: POST /api/v1/check before every send; refusals to /api/v1/consents
                   └──▶ Audience: segment members and changes; message events back; erasures in
```

## What it does

- **Campaigns**: one send to an Audience segment or an imported list (CSV), with a template, now or at a time. An
  A/B test sends two subjects (or two templates) to a share of the audience, waits, and sends the one with more opens
  or clicks to the rest. A campaign can be paused and resumed.
- **Journeys**: started by an event your app posts (`POST /api/v1/events`, such as `signup`) or by a person joining
  an Audience segment. Steps run in order: send (on any channel), wait, a condition (opened or clicked earlier
  messages, consent for a channel now, a field) that sends the others out or to a later step, and leave. A person
  leaves at once when they convert (the goal: an event, or leaving the segment) or opt out on any channel. A paused
  journey takes nobody new, and the people inside wait at their step.
- **Templates** with personal fields: `{{first_name}}`, or `{{first_name|there}}` with a word for people without it.
  Fields come from Audience traits, the list's columns or the event. A WhatsApp template stands for one Meta approved;
  Sync reads them and their approval from Meta, and one that is not approved is not sent.
- **Results** per campaign and journey step: delivered, opened, clicked, bounced, unsubscribed, held back by consent.

## Who gets a message

A message is made for each person and address, then decided **when it is sent**, not when it was scheduled. Every
second, each channel takes the messages that are due, a few seconds' worth at its provider's rate, and for that
batch, right before it goes out:

1. Addresses on Messages' own opt-out list, or with a hard bounce nobody fixed, are dropped.
2. Consent is asked for the whole batch in one `POST /api/v1/check` (purpose from the file, channel `email` or `sms`;
   WhatsApp uses the channel `consent.whatsapp` names, `sms` by default, as İYS counts it under MESAJ). Only people
   whose latest answer is yes are sent to; the others are held back, and the campaign says why. **If Consent cannot
   be asked, nothing is sent**: the batch waits a minute and is asked again.
3. Just before each message, the opt-out list is read once more, so an unsubscribe that arrives during the batch
   still counts.

Without Consent (`consent.check: own`), Messages sends to everyone not on its own opt-out list; use it only for people
you know agreed. With Consent, the own list is still checked first, so an unsubscribe takes effect before Consent has
recorded it.

**Unsubscribe and STOP take effect at once.** Every email has an unsubscribe link in its footer and the
`List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058), so mail apps show an
unsubscribe button. The link's page asks first (so link checkers do not unsubscribe anyone); the button and a mail
app's one-click POST unsubscribe. Every SMS ends with how to stop, from the file. A reply of STOP, RET, İPTAL and the
like to an SMS or a WhatsApp message, an unsubscribe, or a spam complaint from SES: the address goes on the opt-out
list, its waiting messages are cancelled, the person leaves their journeys, and the refusal is sent to Consent
(`POST /api/v1/consents`, granted false, with the campaign as proof) and to Audience as an `unsubscribed` event.

**Bounces.** A hard bounce (SES `Permanent`, an SMTP 550 to RCPT, Netgsm's "number not in service", WhatsApp's 131026)
stops the address until someone chooses "Fixed, send again" on Bounces. `limits.soft_bounce_tries` soft bounces in a
row (3 by default) count as a hard one.

## Never twice, and after a restart

- Each message has a key: the campaign and the address (hashed), or the journey run and the step. The database keeps
  it unique, so a person in a segment twice, the same email on two profiles, a page of the audience read again, or a
  campaign scheduled again still makes one message.
- A message is claimed (state `sending`, committed) before its provider is called. A provider's answer decides what
  follows: accepted is sent; "could not be reached" or 429/5xx is tried again later (1, 2, 4 minutes and so on, six
  times), or through the email fallback; a refusal is failed; and **anything that may have reached the provider** (a
  timeout after the request was written, a connection lost while it answered, a message still `sending` when
  Messages starts) is set to **unknown and never sent again**. Unknown messages are counted on the overview and the
  campaign. This is at most once: rather a message that may be missing than one sent twice.
- A campaign keeps where it stopped reading its audience, so a restart carries on from there. Journeys keep each
  person's step and when it is due.
- The email fallback is used only when the primary surely did not take the message.

## Links and Analytics

Every link in a message is tagged with `utm_source` (the file's `tracking.utm_source`, `messages` by default),
`utm_medium` (`email`, `sms` or `whatsapp`), `utm_campaign` (the campaign's slug, or `journey-<slug>`) and, in an A/B
test, `utm_content` (`a` or `b`). These are the parameters Analytics keeps, so visits and goals count the campaign.
With `tracking.clicks`, the link in the message goes through `/c/<message>/<n>`, which counts the click and redirects
to the tagged address; only the message's own links can be reached that way. With `tracking.opens`, an email carries
a 1x1 image at `/o/<message>.gif`. Opens are a rough measure: image proxies and privacy features open many emails on
their own, and some never load images. WhatsApp's "read" counts as opened; SMS opens are not measured.

## The file

Everything that decides how Messages sends is set in `/config/messages.yaml` (`MESSAGES_CONFIG`); see
[config/messages.yaml](./config/messages.yaml). It is read at start and again within a minute of a change, and applied
whole or not at all; a file with a mistake leaves the last good version in place, and the log, the UI and Settings
say what to fix. Keys are never in the file: each field names the environment variable that holds it.

| Field | Default | |
| --- | --- | --- |
| `sender` | | `name`, `email` (needed for email), `reply_to`, `address` (the postal address in every footer) |
| `providers.email` | | `primary` and `fallback`, each `kind: ses` (`region`, `access_key`, `secret_key`, `session_token`, `configuration_set`, `sns_topic`) or `kind: smtp` (`host`, `port` 587, `security` starttls, tls or none for localhost only, `user`, `password`) |
| `providers.sms` | | `kind: netgsm` (`user`, `password`) or `kind: iletimerkezi` (`key`, `secret`); `sender` (your approved header), `stop` (added to every SMS), `iys` (true: İYS filter on) |
| `providers.whatsapp` | | `phone_number_id`, `business_account_id`, `token`, `app_secret` (webhook signature), `verify_token` |
| each provider | | `rate` (messages a second: `14`, `14/s` or `600/m`), `endpoint` (another API address) |
| `consent` | `consent`, `marketing`, `sms` | `check` (consent or own), `purpose`, `whatsapp` (the Consent channel for WhatsApp) |
| `products.consent`, `products.audience` | | `token` (the variable with that product's API token), `url` (else its address in `OPENASY_PRODUCTS`); Audience also `events` (true) and `changes` (1m) |
| `limits` | | `quiet_hours` (such as `21:00-09:00`: SMS and WhatsApp wait), `timezone` (Europe/Istanbul), `soft_bounce_tries` (3), `phone_country` (TR) |
| `tracking` | | `opens` (true), `clicks` (true), `utm_source` (messages) |

## The providers' webhooks

Integrations shows each address (the SMS ones to admins only).

- **Amazon SES**: make a configuration set that publishes Bounce, Complaint, Delivery and Reject events to an SNS
  topic, subscribe `https://<messages>/hooks/ses` to it (HTTPS), and name the topic in `sns_topic`. Messages
  confirms the subscription itself. Every SNS message is checked before it is read: its signature (version 1 or 2)
  against the certificate at `SigningCertURL`, which must be `https://sns.<region>.amazonaws.com/...pem`; its topic;
  and its age (at most an hour).
- **Netgsm and İleti Merkezi** sign nothing, so their addresses carry a random secret:
  `/hooks/sms/<secret>` for delivery reports and `/hooks/sms/<secret>/inbound` for replies, by GET query or POST
  JSON or form (`jobid` or `id`, `status`, `telno`; `gsmno` or `from`, `msg` or `text`). Reports are also read every
  two minutes from the providers' report APIs for messages sent in the last three days.
- **WhatsApp**: in your Meta app, set the callback to `https://<messages>/hooks/whatsapp` with the verify token from
  `verify_token`, and subscribe to `messages` and `message_template_status_update`. Every POST must carry
  `X-Hub-Signature-256`, the HMAC-SHA256 of the body with the app secret.

## Tested only against fakes

**None of the providers has been called for real.** Each client follows its provider's published API and is tested
against a fake of it in `server/fakes.ts`. Before you rely on one, send to yourself through it and check:

- **Amazon SES**: SigV4 is checked against AWS's published example; `SendEmail` v2 with `Content.Raw`,
  `ConfigurationSetName` and `EmailTags`, answered `{ MessageId }`; the SNS event JSON (`eventType` or
  `notificationType`, `mail.messageId`, `bounce.bounceType`). SNS signatures are tested with a key made in the test,
  not Amazon's certificate.
- **SMTP**: tested against a fake server without TLS; STARTTLS and TLS from the start are not tested here. Only
  bounces given at send time (5xx to RCPT) are seen; bounce emails sent later to the return address are not read.
- **Netgsm**: REST v2 `POST /sms/rest/v2/send` with basic auth, `{ msgheader, messages: [{ msg, no }], encoding: "TR",
  iysfilter: "11" }` answered `{ code: "00", jobid }`, and `POST /sms/rest/v2/report` with `{ jobids }` answered
  `{ jobs: [{ jobid, telno, status }] }`, status 1 delivered and 3 a wrong number. Check the field names, the report
  states and the push format of your account.
- **İleti Merkezi**: `POST /v1/send-sms/json` with `authentication: { key, hash }` (HMAC-SHA256 of the key with the
  secret) and `receipents.number`, answered `{ response: { status: { code: 200 }, order: { id } } }`, and
  `/v1/get-report/json` with states 110, 111 and 112.
- **WhatsApp Cloud API** (Graph v21.0): `POST /{phone-number-id}/messages` with a template and body parameters,
  `GET /{waba-id}/message_templates`, and the webhook's `statuses`, `messages` and
  `message_template_status_update`.
- **Consent and Audience**: the fakes follow their `openapi.json`. Messages has not been run against the real ones.

## Linked products

**Consent**: an editor token of Consent (`products.consent.token`). `POST /api/v1/check` in batches of up to 1000
before each send; refusals go to `POST /api/v1/consents` through an outbox that tries again until Consent takes them.

**Audience**: an editor token of Audience (`products.audience.token`). Campaigns read `GET
/api/v1/segments/{id}/members` page by page; journeys started by a segment read `/changes` every minute (the first
read only notes where to start, so people already in the segment do not enter) and `GET /api/v1/people/{id}` for the
person. `message_sent`, `message_opened`, `message_clicked`, `message_bounced` and `unsubscribed` go to `POST
/api/v1/events` with source `messages` and the campaign and channel, once per message (the event id is the message's).
In Audience, link Messages under `sources.messages` with a Messages API token of the admin role and `delete: true`,
so a person deleted there is deleted here: `POST /api/v1/erasures` deletes their messages' addresses and fields,
list rows, journey runs, clicks and pending calls, and answers `{ status: "done", deleted }`. Opt-outs and hard
bounces keep only the sha256 of the address, so the person is not written to again. The same reference again gets
the same answer.

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/messages.yaml   # your providers, consent and the linked products
docker compose up -d
docker compose logs messages | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and the
API are on http://localhost:8080; the API reference is at `/api/docs/`, and every response is tested against
`openapi.json`. Providers must reach `/hooks/`, and people `/o/`, `/c/` and `/u/`, at `MESSAGES_PUBLIC_URL`: put
Messages behind TLS.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `MESSAGES_PUBLIC_URL` | `http://localhost:8080` | The address people open, and every link in a message points to |
| `MESSAGES_CONFIG` | `/config/messages.yaml` | The file |
| the file's key names | | Each provider's keys and each linked product's token |
| `OPENASY_PRODUCTS` | | The install's other products, for the product switcher and for products without a `url` |
| `MESSAGES_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `MESSAGES_DB` | `/data/messages.db` | SQLite file (WAL), on the `/data` volume |
| `MESSAGES_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `MESSAGES_HEADLESS` | `false` | `true` serves only the API, the tracked links and the webhooks |
| `MESSAGES_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Opens,
clicks and unsubscribes are counted, not logged one by one, and request logs never hold the query string.

## Roles

Viewers see campaigns, journeys, templates, bounces and opt-outs, and preview templates; editors also make and send
campaigns and journeys, templates and lists, post events, and clear bounces; admins also see the webhook addresses,
take erasures, and manage members and API tokens (ADR 0003).

## Limits

- It does not run a mail or SMS server; it sends through your providers.
- Push notifications are not built.
- Delivery is at most once: a message whose fate is unknown is not sent again.
- SMTP bounce emails that arrive later are not read; use SES, or a provider that reports bounces, for that.
- Opens are an estimate (image proxies, privacy features).

## Develop

```bash
npm install
npm test        # the file, every provider client against its fake, sending (consent at send time, never twice, restarts, rate limits, quiet hours, A/B), journeys, webhooks and erasure, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
