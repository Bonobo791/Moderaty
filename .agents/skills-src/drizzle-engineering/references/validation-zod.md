# Validation with drizzle-zod

The schema declares what the database accepts; drizzle-zod derives what the application accepts at
its boundaries — one source of truth, no parallel type definitions.

## Contents

- Generate, don't duplicate
- Insert vs select schemas
- Refinements
- Boundary discipline

## Generate, don't duplicate

```ts
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

const insertUserSchema = createInsertSchema(users);
const selectUserSchema = createSelectSchema(users);
```

Types and validators both derive from the Drizzle schema. When a column changes, the Zod schema
changes — no drift between "what the API accepts" and "what the DB stores."

## Insert vs select schemas

- `createInsertSchema` — validates data going IN: respects `notNull`/`default` (a column with a
  default is optional on insert), enum modes become Zod enums, `mode: 'json'` with `$type<T>()`
  shapes the object schema.
- `createSelectSchema` — validates data coming OUT: everything notNull is required. Use it for
  API response contracts and for parsing rows from raw SQL where inference is weak.

## Refinements

The generated schema is a base — refine it, don't fork it:

```ts
const createUserInput = createInsertSchema(users, {
  email: (schema) => schema.email(),          // refine a column's generated schema
  // or: email: z.string().email(),
}).omit({ id: true, createdAt: true })        // server-owned fields never come from clients
  .extend({ confirmEmail: z.string() });      // form-only fields
```

Rules:

- **Server-owned columns are omitted from client-facing schemas**: primary keys, timestamps,
  `updatedAt` (`$onUpdateFn` owns it), roles/flags a user must not self-assign. If the client
  schema includes `role`, you've built a privilege-escalation endpoint.
- `.strict()` on request bodies in server code — silently stripped unknown keys hide client bugs
  and have historically been a mass-assignment vector.
- Refine at the boundary layer (route/action), keep the base generated schema pure.

## Boundary discipline

1. Validate at every trust boundary: HTTP handlers, server actions, queue consumers, webhook
   receivers. Not "somewhere upstream."
2. `safeParse`, return structured errors; never `.parse` into an unhandled 500 for user input.
3. The database is the last validator, not the only one: Zod gives good errors and rejects early;
   CHECK/NOT NULL/UNIQUE constraints guarantee integrity under races and bugs. Both, always.
4. JSON columns: `$type<T>()` only narrows TypeScript. Old rows may contain old shapes — version
   the shape (a `v` field) or validate on read if the shape is consumed by logic, not just
   displayed.
