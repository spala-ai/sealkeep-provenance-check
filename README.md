# Sealkeep provenance check

A GitHub Action that fails a pull request when a commit names an AI agent
session (a `Sealkeep-Session` trailer) that was not synced to the company's
Sealkeep server.

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: read
jobs:
  provenance:
    runs-on: ubuntu-latest
    steps:
      - uses: spala-ai/sealkeep-provenance-check@v1
        with:
          plane-url: https://sealkeep.company.example/v1/provenance/verify
          token: ${{ secrets.SEALKEEP_PROVENANCE_TOKEN }}
          require: ai        # or: all
```

An organisation admin makes the token with
`sealkeep org provenance token create`, and `sealkeep org provenance`
prints the verify URL. Make the check required in the branch protection
rules.

| Input | Default | Meaning |
|---|---|---|
| `plane-url` | | The verify URL, or the server's base URL |
| `token` | | The organisation's CI token; pass it from a secret |
| `require` | `ai` | `ai` fails on a trailer the server cannot verify; `all` also fails on a commit with no trailer and no `Sealkeep-Session: none` |
| `match-author` | `false` | `true` also fails when the session was synced by someone other than the commit author |
| `repo` | server host + `GITHUB_REPOSITORY` | The repository as `host/owner/name`, as developers' remotes name it |

The check uses only Node's standard library. It sends the server the
repository key and the session references (with `match-author`, also each
commit's author email), and nothing from the code.
