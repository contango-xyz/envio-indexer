import { StrategyProxy } from "generated";
import { Hex, decodeAbiParameters, getContract, parseAbiParameters, toHex } from "viem";
import { strategyBuilderAbi } from "./abis";
import { eventProcessor } from "./accounting/processTransactions";
import { clients } from "./clients";
import { getIMoneyMarketEventsStartBlock } from "./utils/constants";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { EndStrategy, EventType, FeeCollectedEvent, PositionMigratedEvent } from "./utils/types";


export const decodeFeeEvent = (data: Hex) => {
  const [treasury, token, addressReceivingFees, amount, basisPoints] = decodeAbiParameters(
    parseAbiParameters("address,address,address,uint256,uint8"),
    data,
  )
  return { treasury, token, addressReceivingFees, amount, basisPoints }
}

StrategyProxy.EndStrategy.handler(async ({ event, context }) => {
  const entity: EndStrategy = {
    id: createEventId({ ...event, eventType: EventType.END_STRATEGY }),
    chainId: event.chainId,
    contangoPositionId: event.params.positionId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    eventType: EventType.END_STRATEGY,
  }
  await eventProcessor.processEvent(entity, context)
})

StrategyProxy.StragegyExecuted.handler(async ({ event, context }) => {
  const action = event.params.action as Hex

  if (action === toHex("FeeCollected", { size: 32 })) {
    const decoded = decodeFeeEvent(event.params.data as Hex)
    const token = await getOrCreateToken({ chainId: event.chainId, address: decoded.token, context })
    const eventId = createEventId({ ...event, eventType: EventType.FEE_COLLECTED })
    const entity: FeeCollectedEvent = {
      id: eventId,
      chainId: event.chainId,
      contangoPositionId: event.params.position1,
      trader: event.params.user,
      treasury: decoded.treasury,
      token_id: token.id,
      amount: decoded.amount,
      basisPoints: decoded.basisPoints,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      eventType: EventType.FEE_COLLECTED,
    }

    await eventProcessor.processEvent(entity, context)

  }

  if (action === toHex("PositionMigrated", { size: 32 })) {
    const eventId = createEventId({ ...event, eventType: EventType.MIGRATED })

    const entity: PositionMigratedEvent = {
      id: eventId,
      chainId: event.chainId,
      oldContangoPositionId: event.params.position1,
      newContangoPositionId: event.params.position2,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      eventType: EventType.MIGRATED,
    }
    await eventProcessor.processEvent(entity, context)
  }
})

StrategyProxy.Upgraded.contractRegister(async ({ event, context }) => {
  if (event.block.number >= getIMoneyMarketEventsStartBlock(event.chainId)) {
    const contract = getContract({ address: event.srcAddress as `0x${string}`, abi: strategyBuilderAbi, client: clients[event.chainId] })
    const simpleSpotExecutor = await contract.read.spotExecutor({ blockNumber: BigInt(event.block.number)})
    console.log('StrategyProxy simpleSpotExecutor updated', simpleSpotExecutor, event.chainId, event.block.number)
    context.addSimpleSpotExecutor(simpleSpotExecutor)
  }
})
