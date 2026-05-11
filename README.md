# revy

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.tsx
```

To export comments for another tool instead of dispatching an agent from Revy:

```bash
revy --output /tmp/revy-comments.json
```

The bundled Pi extension registers `/brevy`. It launches Revy, lets you add comments, then inserts those comments into the current Pi prompt editor when Revy exits. You can override the launch command with `REVY_COMMAND`, for example:

```bash
REVY_COMMAND="bun run /path/to/revy/src/index.tsx" pi
```

This project was created using `bun init` in bun v1.3.13. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
