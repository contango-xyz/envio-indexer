import { Chain, Hex } from "viem"
import { arbitrum, avalanche, mainnet } from "viem/chains"

const strategyBuilderProxy = '0x5BDeB2152f185BF59f2dE027CBBC05355cc965Bd'

export const strategyContractsAddresses = (chainId: Chain['id']): Set<Hex> => {
  const result = [strategyBuilderProxy]
  const past = pastStrategyContracts.get(chainId) || []
  result.push(...past)
  return new Set(result.map((x) => x.toLowerCase() as Hex))
}

const pastStrategyContracts = new Map<Chain['id'], Hex[]>([
  [mainnet.id, ["0x6b70b0ec487a28d79c59d78005da199217d7bcc9", "0xde7ffc0e76d80561efb88cfeb70f7835fc47817d"]],
  [
    arbitrum.id,
    [
      "0x1bdf9321a820a469d27898700d6be67bb192fba9",
      "0x35d117f78a8a8c20a78c6948b1176fc3862940fc",
      "0x853244570b8925c72b351eb0c35c2b01627e9077",
    ],
  ],
  [avalanche.id, ["0x14334b85ca27a11e32d80c898c9a9892bcb62fe6"]],
])
