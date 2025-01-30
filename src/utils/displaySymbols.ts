import { Chain } from "viem"
import { arbitrum, gnosis, optimism, polygon } from "viem/chains"

const isUSDCe = (address: string, chainId: Chain['id']) => {
  switch (chainId) {
    case optimism.id:
      return address === "0x7f5c764cbc14f9669b88837ca1490cca17c31607"
    case arbitrum.id:
      return address === "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"
    case polygon.id:
      return address === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
    default:
      return false
  }
}

// just do the basics, not the PT's for example. The point of doing this here, is that it allows us to do queries for stuff like "USDC.e" on all chains
export const symbolToDisplaySymbol = ({ address, symbol: symbol, chainId }: { address: string; symbol: string; chainId: Chain['id'] }) => {
  if (isUSDCe(address, chainId)) return "USDC.e"
  if (symbol === "WETH") return 'ETH'
  if (symbol === "WMATIC") return 'MATIC'
  if (symbol === "WXDAI") return 'DAI'
  if (symbol === "WAVAX") return 'AVAX'
  if (symbol === "WBNB") return 'BNB'
  if (symbol === "DAI.e") return 'DAI'
  if (symbol === "WETH.e") return 'ETH'
  if (symbol === "AAVE.e") return 'AAVE'
  if (symbol === "LINK.e") return 'LINK'
  if (symbol === "USDt") return 'USDT'
  if (symbol === "sDAI" && chainId === gnosis.id) return 'sexyDAI'

  return symbol
}
