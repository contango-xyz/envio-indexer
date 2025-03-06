import { Token } from "generated";
import { FeeCollectedEvent, PositionUpsertedEvent } from "../../utils/types";
import { CashflowCurrency } from "../legacy";
import { PriceConverters } from "./prices";

export const withFees = ({ converters, feeEvents, positionUpsertedEvents, collateralToken, debtToken }: { converters: PriceConverters; feeEvents: FeeCollectedEvent[]; positionUpsertedEvents: PositionUpsertedEvent[]; collateralToken: Token; debtToken: Token }) => {
  const { baseToQuote, quoteToBase } = converters

  let feeToken_id;
  let fee = 0n
  let fee_long = 0n
  let fee_short = 0n

  if (feeEvents.length > 0) {
    const feeEvent = feeEvents[0]
    feeToken_id = feeEvent.token_id
    fee = feeEvent.amount
  } else if (positionUpsertedEvents.length > 0) {
    // old fees (on position upserted events)
    const events = positionUpsertedEvents.filter(event => event.fee > 0n)
    if (events.length > 0) {
      // there should only be one position upserted event, but certainly only one with a fee
      const event = events[0]
      feeToken_id = Number(event.feeCcy) === CashflowCurrency.Base ? collateralToken.id : debtToken.id
      fee = event.fee
    }
  }

  if (feeToken_id === collateralToken.id) {
    fee_short += fee
    fee_long += baseToQuote(fee)
  } else if (feeToken_id === debtToken.id) {
    fee_long += fee
    fee_short += quoteToBase(fee)
  }

  return { feeToken_id, fee, fee_long, fee_short }
}

export type FillItemWithPricesAndFees = Awaited<ReturnType<typeof withFees>>

