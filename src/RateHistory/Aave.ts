import { RateHistoryAave, ReserveDataUpdated } from "generated";
import { getOrCreateToken } from "../utils/getTokenDetails";

const createReserveDataUpdatedId = ({ chainId, tokenAddress, marketId, blockNumber }: { chainId: number; tokenAddress: string; marketId: string; blockNumber: number; }) => {
  return `${chainId}_${tokenAddress}_${marketId}_${blockNumber}`
}

const srcContractToMoneyMarket = (srcContract: string) => {
  switch (srcContract.toLowerCase()) {
    case "0x794a61358d6845594f94dc1db02a252b5b4814ad":
      return 'AaveV3'
    default:
      return 'Unknown'
  }
}

RateHistoryAave.ReserveDataUpdated.handler(async ({ event, context }) => {
  const token = await getOrCreateToken({ chainId: event.chainId, address: event.params.reserve, context })
  context.Token.set(token)
  const entity: ReserveDataUpdated = {
    id: createReserveDataUpdatedId({ chainId: event.chainId, tokenAddress: event.params.reserve, marketId: event.srcAddress, blockNumber: event.block.number }),
    token_id: token.id,
    timestamp: event.block.timestamp,
    blockNumber: event.block.number,
    chainId: event.chainId,
    lendingIndex: event.params.liquidityIndex,
    borrowingIndex: event.params.variableBorrowIndex,
    moneyMarket: srcContractToMoneyMarket(event.srcAddress),
  }
  context.ReserveDataUpdated.set(entity)
})

