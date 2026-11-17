# Standalone Git Forge

Git smart HTTP v2/v0, REST v3, GraphQL and MCP backed by one in-memory object store. Built for [make.fun](https://make.fun).

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/meimekh/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/meimekh/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Run `node main.ts` with MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN set by the competition environment. Node 22.18+; standard library only.

`app.ts` routes requests; `src/objects.ts` handles packs and objects; `src/store.ts` owns repository state; git, REST, GraphQL and MCP modules share that store. `scripts/selftest.js` exercises the official kit suite locally.

Local independent verification: 120/120 checks passed; performance 181/200 on this machine (not a server grade). Git 30/30, GraphQL 20/20, issues 15/15, MCP 15/15, protocol 5/5, pulls 20/20, repos 15/15.
