# Token scopes

A token request carries `scope`, a comma-separated list of scope names, such
as `read,write`. The names are `read` and `write`, and spaces around a name
are ignored.

- A request names at least one scope. A list that is empty, or that has an
  empty entry, is refused.
- A name appears once.
- A name that is not a scope is refused.
