import { arbitrum, avalanche, base, bsc, gnosis, linea, mainnet, optimism, polygon, scroll } from 'viem/chains'

const moneyMarketEventsStartBlocks = {
  [arbitrum.id]: 285426286,
  [optimism.id]: 129385005,
  [mainnet.id]: 21416583,
  [polygon.id]: 65559679,
  [gnosis.id]: 37558495,
  [base.id]: 23789975,
  [linea.id]: 13392112,
  [scroll.id]: 11963642,
  [avalanche.id]: 54428370,
  [bsc.id]: 44924353,
}

export const getIMoneyMarketEventsStartBlock = (chainId: number) => {
  return moneyMarketEventsStartBlocks[chainId as keyof typeof moneyMarketEventsStartBlocks] ?? 0n
}
