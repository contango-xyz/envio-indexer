import { ContangoFeeCollectedEvent, ContangoPositionMigratedEvent, StrategyProxy } from "generated";
import { Hex, decodeAbiParameters, getContract, parseAbiParameters, toHex } from "viem";
import { eventStore } from "./Store";
import { eventsReducer } from "./accounting/processEvents";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { EventType } from "./utils/types";
import { strategyBuilderAbi } from "./abis";
import { clients } from "./clients";
import { getIMoneyMarketEventsStartBlock } from "./utils/constants";

export const decodeFeeEvent = (data: Hex) => {
  const [treasury, token, addressReceivingFees, amount, basisPoints] = decodeAbiParameters(
    parseAbiParameters("address,address,address,uint256,uint8"),
    data,
  )
  return { treasury, token, addressReceivingFees, amount, basisPoints }
}

StrategyProxy.EndStrategy.handler(async ({ event, context }) => {
  const snapshot = await eventStore.getCurrentPositionSnapshot({ event, context })
  if (snapshot) {
    await eventsReducer({ ...snapshot, context })
    // safe to delete the snapshot here because we KNOW that it's the last event in the tx
    eventStore.deletePositionSnapshot(event)
  }

})

StrategyProxy.StragegyExecuted.handler(async ({ event, context }) => {
  const action = event.params.action as Hex

  if (action === toHex("FeeCollected", { size: 32 })) {
    const decoded = decodeFeeEvent(event.params.data as Hex)
    const token = await getOrCreateToken({ chainId: event.chainId, address: decoded.token, context })
    const eventId = createEventId({ ...event, eventType: EventType.FEE_COLLECTED })
    const entity: ContangoFeeCollectedEvent = {
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
    }

    context.ContangoFeeCollectedEvent.set(entity)
    eventStore.addLog({ event, contangoEvent: { ...entity, eventType: EventType.FEE_COLLECTED } })

  }

  if (action === toHex("PositionMigrated", { size: 32 })) {
    const eventId = createEventId({ ...event, eventType: EventType.MIGRATED })
    const entity: ContangoPositionMigratedEvent = {
      id: eventId,
      chainId: event.chainId,
      oldContangoPositionId: event.params.position1,
      newContangoPositionId: event.params.position2,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
    }
    context.ContangoPositionMigratedEvent.set(entity)
    eventStore.addLog({ event, contangoEvent: { ...entity, eventType: EventType.MIGRATED } })

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
