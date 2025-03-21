import {
  ContangoProxy,
  Instrument,
  PositionNFT,
  UnderlyingPositionFactory,
  UnderlyingPositionFactory_UnderlyingPositionCreated
} from "generated";
import { Hex, getContract, toHex, zeroAddress } from "viem";
import { contangoAbi } from "./abis";
import { createPosition } from "./accounting/positions";
import { eventProcessor } from "./accounting/processTransactions";
import { clients } from "./clients";
import { createInstrumentId, getPosition, getPositionSafe } from "./utils/common";
import { getIMoneyMarketEventsStartBlock } from "./utils/constants";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { strategyContractsAddresses } from "./utils/previousContractAddresses";
import { EventType, PositionUpsertedEvent } from "./utils/types";

// re-run indexing again again again
ContangoProxy.PositionUpserted.handler(async ({ event, context }) => {
  const contangoEvent: PositionUpsertedEvent = {
    ...event.params,
    contangoPositionId: event.params.positionId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    chainId: event.chainId,
    id: createEventId({ ...event, eventType: EventType.POSITION_UPSERTED }),
    transactionHash: event.transaction.hash,
    eventType: EventType.POSITION_UPSERTED,
  }

  await eventProcessor.processEvent(contangoEvent, context)
})

// On create, the NFT transfer event is emitted before the UnderlyingPositionCreated event
PositionNFT.Transfer.handler(async ({ event, context }) => {
  const positionId = toHex(event.params.tokenId, { size: 32 }).toLowerCase() as Hex
  const [to, from] = [event.params.to, event.params.from].map(address => address.toLowerCase()) as Hex[]

  if (event.srcAddress.toLowerCase() !== '0xc2462f03920d47fc5b9e2c5f0ba5d2ded058fd78') return; // bug in envio causing this handler to pick up some scam tsx for example on this tx hash: 0xc1d5865badca9ee1f7d787c1d69f42621dd10a6ac8affad2d8d3d89ce9393ae2

  await eventProcessor.processEvent({
    ...event,
    eventType: EventType.TRANSFER_NFT,
    contangoPositionId: positionId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    chainId: event.chainId,
    id: createEventId({ ...event, eventType: EventType.TRANSFER_NFT }),
    from,
    to,
  }, context)

  if (event.params.from !== zeroAddress) {
    // if the transfer is to the strategy builder, we don't update the owner.
    // This is important because when we evaluate cashflows, we need to know the cashflows of the actual owner and not the "temporary" owner
    const isTransferToStrategyBuilder = strategyContractsAddresses(event.chainId).has(to)
    const position = await getPositionSafe({ chainId: event.chainId, positionId, context })

    if (position) {
      const owner = isTransferToStrategyBuilder || to === zeroAddress ? position.owner : to
  
      context.Position.set({ ...position, owner })
    } else {
      if (!strategyContractsAddresses(event.chainId).has(from)) throw new Error(`Position not found for NFT transfer event. tx hash: ${event.transaction.hash}`)
      
      return;
      // if no position exists yet, it means we're in a migration transaction and it'll be handled by the eventsReducer()
    }
  } else {
    // transfer from zero address means the NFT is being created, and hence a position is being created
    await createPosition({ ...event, contangoPositionId: positionId, owner: to, proxyAddress: zeroAddress, context })
  }
});

export const createUnderlyingPositionId = ({ chainId, proxyAddress }: { chainId: number; proxyAddress: string; }) => `${chainId}_${proxyAddress.toLowerCase()}`

UnderlyingPositionFactory.UnderlyingPositionCreated.handler(async ({ event, context }) => {
  if (!event.transaction.from) throw new Error('UnderlyingPositionCreated event has no from address')
  const proxyAddress = event.params.account.toLowerCase()
  const position = await getPosition({ chainId: event.chainId, contangoPositionId: event.params.positionId, context })
  context.Position.set({ ...position, proxyAddress })

  const underlyingPosition: UnderlyingPositionFactory_UnderlyingPositionCreated = {
    id: createUnderlyingPositionId({ chainId: event.chainId, proxyAddress }),
    contangoPositionId: event.params.positionId,
    account: event.params.account.toLowerCase(),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    chainId: event.chainId,
    transactionHash: event.transaction.hash,
  }

  // create this mapping for us to look up proxy->positionId->position when processing liquidations
  context.UnderlyingPositionFactory_UnderlyingPositionCreated.set(underlyingPosition)
});


ContangoProxy.InstrumentCreated.handler(async ({ event, context }) => {
  const { chainId, params } = event
  const [collateralToken, debtToken] = await Promise.all([
    getOrCreateToken({ address: params.base, chainId, context }),
    getOrCreateToken({ address: params.quote, chainId, context }),
  ]);

  const instrumentId = event.params.symbol.slice(0, 34)

  const entity: Instrument = {
    id: createInstrumentId({ chainId, instrumentId }),
    chainId: event.chainId,
    instrumentId,
    collateralToken_id: collateralToken.id,
    debtToken_id: debtToken.id,
    closingOnly: false,
  };

  context.Instrument.set(entity);
});


ContangoProxy.ClosingOnlySet.handler(async ({ event, context }) => {
  const { chainId, params } = event
  const instrument = await context.Instrument.get(createInstrumentId({ chainId, instrumentId: params.symbol }))
  if (!instrument) throw new Error('Instrument not found')

  context.Instrument.set({ ...instrument, closingOnly: event.params.closingOnly })
})

ContangoProxy.Upgraded.contractRegister(async ({ event, context }) => {
  if (event.block.number >= getIMoneyMarketEventsStartBlock(event.chainId)) {
    const contract = getContract({ address: event.srcAddress as `0x${string}`, abi: contangoAbi, client: clients[event.chainId] })
    const spotExecutor = await contract.read.spotExecutor({ blockNumber: BigInt(event.block.number)})
    console.log('ContangoProxy spotExecutor updated', spotExecutor, event.chainId, event.block.number)
    context.addSpotExecutor(spotExecutor)
  }
})
