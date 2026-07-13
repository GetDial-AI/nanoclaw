# Remove Dial Tool

Reverses `/add-dial-tool`. The deterministic uninstall is a single idempotent script:

```bash
bash .claude/skills/add-dial-tool/remove.sh
```

It: removes `@getdial/cli` from `container/cli-tools.json`; deletes `container/skills/dial-cli` and its per-session copies; deletes the OneCLI "Dial API" secret and strips it from every agent; rebuilds the image (only if the manifest changed) and stops running containers so they respawn without the tool.

Removes the **tool** only — it does not touch the Dial **channel** (`/add-dial`).
