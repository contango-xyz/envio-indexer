import { Chain, createPublicClient, http, PublicClient } from "viem";
import { arbitrum, avalanche, base, bsc, gnosis, linea, mainnet, optimism, polygon, scroll } from "viem/chains";
import { recordEntries, recordFromEntries } from "./utils/record-utils";

const chainIdToAlchemyNetworkNameMap: Record<number, string> = {
  [arbitrum.id]: "arb-mainnet",
  [optimism.id]: "opt-mainnet",
  [mainnet.id]: "eth-mainnet",
  [polygon.id]: "polygon-mainnet",
  [base.id]: "base-mainnet",
  [gnosis.id]: "gnosis-mainnet",
  [bsc.id]: "bnb-mainnet",
  [scroll.id]: "scroll-mainnet",
  [avalanche.id]: "avax-mainnet",
  [linea.id]: "linea-mainnet",
}

export const chainIdToAlchemyNetworkName = (network: Chain['id']): string | null => {
  return chainIdToAlchemyNetworkNameMap[network] ?? null
}

export const ALCHEMY_KEY = "seYm94zB0TtDUVmSnRONr-EPHbMEXLzQ"

export const alchemyUrl = (network: Chain['id'], protocol: "https" | "wss", key = ALCHEMY_KEY) => {
  const alchemyNetworkName = chainIdToAlchemyNetworkName(network)

  if (alchemyNetworkName === null) {
    throw new Error(`Unknown network: ${network}`)
  }

  return `${protocol}://${alchemyNetworkName}.g.alchemy.com/v2/${key}`
}

const alchemyHttp = (chain: Chain['id']) => http(alchemyUrl(chain, "https"))

export const publicClientConfigsById = {
  [mainnet.id]: {
    chain: mainnet,
    transport: alchemyHttp(mainnet.id),
  },
  [optimism.id]: {
    chain: optimism,
    transport: alchemyHttp(optimism.id),
  },
  [bsc.id]: {
    chain: bsc,
    transport: alchemyHttp(bsc.id),
  },
  [gnosis.id]: {
    chain: gnosis,
    transport: alchemyHttp(gnosis.id),
  },
  [polygon.id]: {
    chain: polygon,
    transport: alchemyHttp(polygon.id),
  },
  [base.id]: {
    chain: base,
    transport: alchemyHttp(base.id),
  },
  [arbitrum.id]: {
    chain: arbitrum,
    transport: alchemyHttp(arbitrum.id),
  },
  [avalanche.id]: {
    chain: avalanche,
    transport: alchemyHttp(avalanche.id),
  },
  [linea.id]: {
    chain: linea,
    transport: alchemyHttp(linea.id),
  },
  [scroll.id]: {
    chain: scroll,
    transport: alchemyHttp(scroll.id),
  },
}

export const clients: Record<Chain['id'], PublicClient> = recordFromEntries(
  recordEntries(publicClientConfigsById).map(([chainId, config]) => {
    // TODO: Viem says in the docs some RPCs may have limits for calldata size,
    // so far Alchemy seems to work with 20kb, but no idea for the free ones we use for Gnosis

    const httpClient = createPublicClient({
      ...config,
      batch: {
        multicall: {
          batchSize: 1024, // 1kb
          wait: 10, // 10ms
        },
      },
      cacheTime: 5000,
    })
    return [chainId, httpClient]
  }),
)
