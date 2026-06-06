# managedb CLI

Small private utility for inspecting and deleting stories in the local Signet database.

## Commands

From the project root:

```bash
node managedb liststories
```

Lists all stories as:

- story id
- story title
- user name

Delete one story by id:

```bash
node managedb deletestory <id>
```

Example:

```bash
node managedb deletestory 9e0dbb58-ed36-420c-9c7d-203082be7dfd
```

## Alternative invocation

You can also run:

```bash
node managedb.js liststories
node managedb.js deletestory <id>
```

Or via npm:

```bash
npm run managedb -- liststories
npm run managedb -- deletestory <id>
```

## Notes

- `stories.id` is a unique id in the database.
- `deletestory` is permanent (no undo).
- If no matching id exists, the command exits with an error.
