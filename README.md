# btc-dip-buy-bot-3

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/meviusorg5799/btc-dip-buy-bot-3/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/meviusorg5799/btc-dip-buy-bot-3/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A dip-buy mean-reversion bot that trades cbBTC/USDC minute by minute on $1,000 of paper money. It buys dips in tranches as price falls away from its trailing 120-bar high, sells back in stages as price reverts past the average entry, and trades small dips against a 30-bar EMA while the book is flat. Long only, deterministic, standard library only. Runs on Node 22 (the kit's process driver runs Node bots only; a Python entry would need Docker, which this machine lacks).

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout via the kit shim in `vendor/`. Grade it locally with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=meviusorg5799&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
