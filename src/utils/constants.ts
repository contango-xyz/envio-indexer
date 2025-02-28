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

// ALL USE STANDARD DEPOSIT/WITHDRAWAL EVENTS EXCEPT ARBITRUM AND SCROLL
// IMPORTANT: If adding an address here, make sure to lowercase it
export const wrappedNativeMap = {
  [mainnet.id]: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  [optimism.id]: '0x4200000000000000000000000000000000000006',
  [arbitrum.id]: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // Not standard Deposit/Withdrawal events (uses Transfer event to/from zero address) NOT STANDARD!!!!
  [polygon.id]: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  [base.id]: '0x4200000000000000000000000000000000000006',
  [linea.id]: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
  [scroll.id]: '0x5300000000000000000000000000000000000004', // uses both the standard Deposit/Withdrawal events. Make sure to only use the Deposit/Withdrawal events on scroll to avoid double counting
  [avalanche.id]: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
  [gnosis.id]: '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d',
  [bsc.id]: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
}