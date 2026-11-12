# Token scopes

A token request carries `scope`, a comma-separated list of scope names with
no spaces, such as `read,write`. The names are `read` and `write`.

- A request names at least one scope. A list that is empty, or that holds
  only separators, is refused with `400 invalid_scope`.
- A name that is not a scope is refused with `400 invalid_scope`.
- `None` is the value a token is left with when its last scope is revoked. A
  request never produces it, because a client that sent no scope has made a
  mistake and has to be told.
