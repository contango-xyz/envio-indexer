import { ERC20, ERC20_Transfer_event, WrappedNative } from "generated";
import { ADDRESSES } from "./utils/constants";
import { createEventId } from "./utils/ids";
import { EventType, TransferEvent } from "./utils/types";
import { zeroAddress } from "viem";
import { eventProcessor } from "./accounting/processTransactions";
const depositWithdrawalAddresses: string[] = [
  ADDRESSES.vaultProxy,
  ADDRESSES.maestroProxy, // cashflow in alternative ccy goes to the maestro proxy (or at least did in the past)
]

const depositWithdrawalFilters = depositWithdrawalAddresses.map(address => ([{ from: address }, { to: address }])).flat()
const wrappedNativeWithdrawalFilters = depositWithdrawalAddresses.map(address => ({ src: address }))
const wrappedNativeDepositFilters = depositWithdrawalAddresses.map(address => ({ dst: address }))

const createContangoEvent = (event: ERC20_Transfer_event): TransferEvent => ({
  ...event,
  id: createEventId({ ...event, eventType: EventType.TRANSFER }),
  blockNumber: event.block.number,
  blockTimestamp: event.block.timestamp,
  transactionHash: event.transaction.hash,
  from: event.params.from.toLowerCase(),
  to: event.params.to.toLowerCase(),
  value: event.params.value,
  srcAddress: event.srcAddress.toLowerCase(),
  eventType: EventType.TRANSFER,
})

ERC20.Transfer.handler(async ({ event, context }) => {
  await eventProcessor.processEvent(createContangoEvent(event), context)
},
{
  wildcard: true,
  eventFilters: depositWithdrawalFilters
})

WrappedNative.Deposit.handler(async ({ event, context }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: zeroAddress,
      to: event.params.dst,
      value: event.params.wad
    }
  }

  await eventProcessor.processEvent(createContangoEvent(erc20Event), context)
},
{
  eventFilters: wrappedNativeDepositFilters
})

WrappedNative.Withdrawal.handler(async ({ event, context }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: event.params.src,
      to: zeroAddress,
      value: event.params.wad
    }
  }

  await eventProcessor.processEvent(createContangoEvent(erc20Event), context)
},
{
  eventFilters: wrappedNativeWithdrawalFilters
})
