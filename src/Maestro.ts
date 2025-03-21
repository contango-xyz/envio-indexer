import { Maestro } from "generated";
import { getContract } from "viem";
import { maestroAbi } from "./abis";
import { eventProcessor } from "./accounting/processTransactions";
import { clients } from "./clients";
import { getIMoneyMarketEventsStartBlock } from "./utils/constants";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { EventType, FeeCollectedEvent } from "./utils/types";

Maestro.Upgraded.contractRegister(async ({ event, context }) => {
  if (event.block.number >= getIMoneyMarketEventsStartBlock(event.chainId)) {
    const contract = getContract({ address: event.srcAddress as `0x${string}`, abi: maestroAbi, client: clients[event.chainId] })
    const simpleSpotExecutor = await contract.read.spotExecutor({ blockNumber: BigInt(event.block.number)})
    console.log('Maestro simpleSpotExecutor updated', simpleSpotExecutor, event.chainId, event.block.number)
    context.addSimpleSpotExecutor(simpleSpotExecutor)
  }
})

Maestro.FeeCollected.handler(async ({ event, context }) => {
  const token = await getOrCreateToken({ chainId: event.chainId, address: event.params.token, context })
  const eventId = createEventId({ ...event, eventType: EventType.FEE_COLLECTED })
  const entity: FeeCollectedEvent = {
    id: eventId,
    chainId: event.chainId,
    contangoPositionId: event.params.positionId,
    trader: event.params.trader,
    treasury: event.params.treasury,
    token_id: token.id,
    amount: event.params.amount,
    basisPoints: Number(event.params.basisPoints),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    eventType: EventType.FEE_COLLECTED,
  }

  await eventProcessor.processEvent(entity, context)
})
