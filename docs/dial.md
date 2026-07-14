# Dial channel

[Dial](https://getdial.ai) gives a NanoClaw agent a real phone number for **SMS and AI voice calls**. It is a native channel adapter (no Chat SDK bridge): outbound texts go through the `@getdial/sdk` client, and inbound texts/calls arrive via the Dial CLI's command-target daemon.

## Setup

Run setup and pick **Dial** in the channel picker:

```bash
bash nanoclaw.sh
# → Standard setup → channel picker → Dial
```

The wizard signs you in to Dial (reuse an existing session, or sign up with email + OTP), confirms the account's number, installs the adapter, wires the inbound listener, and pairs your phone to the agent's public line by texting a short code.

You can also install the channel later with the `/add-dial` skill.

## How it works

- **Outbound** — the agent replies through `DialClient.sendMessage` from `@getdial/sdk`.
- **Inbound** — the `dial listen` daemon runs a handler per event, spooling event JSON into `data/dial/inbound/`, which the adapter watches. Routed events: `message.received` (external senders) and `call.ended`.
- **The public line** — the Dial number is a single public, threaded line: one messaging group whose `platform_id` is the number, with each texter as a thread. Anyone can reach the agent.
- **Credentials** — read from `~/.local/share/dial/auth.v1.json` (`apiKey`, `phoneNumber`) or `DIAL_*` env vars.

## Multiple numbers

One NanoClaw install can answer on several Dial numbers. After the channel is set up, run **`/add-dial-number`** to add another public line (e.g. a personal line plus a support line). The adapter routes each number independently.

## Dial as a tool (optional)

Independent of the channel, **`/add-dial-tool`** bakes the `dial` CLI into the agent container and wires OneCLI credential injection, so any agent — on any channel — can send SMS, place AI voice calls, and receive verification codes from inside the sandbox.

## Known limitations

- **Multiple Dial numbers in the setup wizard are not supported.** If your Dial account has more than one number, choosing which one to use during setup is not supported.
