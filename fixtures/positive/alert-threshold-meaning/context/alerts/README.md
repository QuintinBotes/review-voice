# Alerts

The rules in this directory are `alert_rule` resources of the `alert`
provider. Its arguments:

- `expression`: the series the rule evaluates.
- `threshold`: on a rule over an absolute value, the value above which the
  rule fires. A ratio rule leaves it out and fires at the ratio the provider
  is configured with.
- `sample_floor`: on a ratio rule, the number of calls the denominator needs
  before the rule is evaluated at all.
- `routing_key`: the route that is paged. A rule without one pages the
  `primary` route.

The routes `primary` and `secondary` are declared in the on-call tool, not in
this repository.
