# Walkthrough: reserve, lose the response, recover, cancel

Run `npm run demo` first. It uses a deterministic MCP client and real local services; it does **not** run a model.

## 1. Establish identity before execution

The trusted Controller approves an intent:

```json
{"intentRef":"order-42-line-1-v1","warehouseId":"demo-warehouse","sku":"CAT-001","quantity":3}
```

A Grant contains exactly this intent and allowed actions. Two clients submit the same input through separate gateways. Both receive the same Operation ID. Initial stock is 10.

## 2. Stop in the uncertain window

The worker records dispatch. The inventory service atomically reserves 3 and creates a receipt, but the response is held.

| Observer | Fact |
|---|---|
| Inventory database | Reservation exists; stock is 7 |
| Governance database | `DISPATCH_RECORDED`; result is absent |
| Client | Does not yet have business success evidence |

The demo kills worker A. The difference between these observations is intentional—not an excuse to declare that the action failed.

## 3. Recover the original responsibility

Worker B claims the original Operation with a newer executor epoch. It inspects the backend, verifies business identity and input, and records the existing receipt. It does not deduct stock again.

An agent-authority change then rejects the old producer's new command. A newly issued Grant queries the original intent and obtains the original Operation. This separates the agent's authority from the platform's existing responsibility.

## 4. Cancel with evidence

Cancellation changes desired action and creates a compensating operation. A second identical cancellation request does not release twice.

```text
original reservation: APPLIED
compensation:         APPLIED
business state:       RELEASED
stock:                10 → 7 → 10
effect count:         reserve=1, release=1
```

The demo additionally lets cancellation close an intent before a delayed reserve applies, then replays duplicate/out-of-order state events into a projection.

## 5. Know when not to continue

With reconciliation capability hidden, a lost response leads to `OUTCOME_UNKNOWN / RECONCILIATION_UNSUPPORTED`. The experiment controller can inspect fixture stock, but the worker cannot use evidence its interface does not provide.

If inventory has already been consumed, compensation is rejected. An old reservation receipt is not proof of cancellation success.

## 6. Include the scheduler in recovery

With a compatible installed Codex, run:

```sh
npm run agent:cold -- after_commit
```

This uses a simulated Responses provider with a real native runtime. It kills scheduler, runner and worker after the inventory commit. The replacement scheduler receives only the data directory and trusted service configuration, reads durable Run lineage, fences the lost execution and creates a successor. The new Agent obtains current business facts through MCP.

Other cuts are `before_launch`, `after_spawn` and `before_consume`. `before_launch` includes competing replacement schedulers. `after_spawn` witnesses the Agent PID, not just a planned launch. `before_consume` tests completion evidence that was durable before scheduler acknowledgement.

Each experiment creates a new data directory. A fresh rerun of a failed experiment is **not** recovery of the original failed experiment's task. Keep both records and distinguish these claims.
