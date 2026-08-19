import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Info, ShoppingCart, Trash2, Truck } from 'lucide-react';
import { useCart, priceCartLine } from '../hooks/useCart';
import { Card, EmptyState, PageHeader, Pill } from '../components/ui';
import { currency, number } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * PROCUREMENT CART
 * ================
 *
 * The staging area between deciding what to buy and committing a purchase
 * order. Lines are grouped by distributor because that is how orders are
 * actually placed — one order per distributor.
 *
 * Creating the order posts to the API, which re-prices every line from the
 * distributor's own catalogue. The totals shown here are an estimate computed
 * client-side; the purchase order carries the authoritative figures.
 */

interface CreatedOrder {
  po_number: string;
  distributor_name: string;
  total_amount: number;
  free_units: number;
  savings_amount: number;
  id: number;
}

export default function ProcurementCart() {
  const cart = useCart();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedOrder[]>([]);

  async function createOrders() {
    setBusy(true);
    setErrors([]);
    const results: CreatedOrder[] = [];
    const failures: string[] = [];

    // One purchase order per distributor. Each is independent: a rejected
    // order (below minimum value, say) must not block the others.
    for (const group of cart.byDistributor) {
      try {
        const po = await api.post<CreatedOrder & { distributor_name: string }>(
          '/procurement/purchase-orders',
          {
            distributor_id: group.distributorId,
            status: 'SENT',
            items: group.lines.map((line) => ({
              product_id: line.productId,
              quantity: line.quantity,
            })),
          },
        );
        results.push({ ...po, distributor_name: group.distributorName });
        cart.clearDistributor(group.distributorId);
      } catch (err) {
        failures.push(
          `${group.distributorName}: ${err instanceof ApiError ? err.message : 'could not be ordered'}`,
        );
      }
    }

    setCreated(results);
    setErrors(failures);
    setBusy(false);
  }

  if (cart.count === 0 && created.length === 0) {
    return (
      <>
        <PageHeader title="Procurement Cart" subtitle="Build a basket, then turn it into purchase orders" />
        <Card>
          <EmptyState
            title="Your cart is empty"
            icon={ShoppingCart}
            message="Add products from the Replenishment Center, a supplier comparison, a distributor catalogue, or straight from a Mini Analyst recommendation."
            action={
              <Link to="/procurement/replenishment" className="btn-primary">
                Open Replenishment Center
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const cartTotals = cart.lines.reduce(
    (acc, line) => {
      const priced = priceCartLine(line);
      return {
        net: acc.net + priced.net,
        free: acc.free + priced.freeQty,
        savings: acc.savings + priced.savings,
        units: acc.units + priced.totalUnits,
      };
    },
    { net: 0, free: 0, savings: 0, units: 0 },
  );

  return (
    <>
      <PageHeader
        title="Procurement Cart"
        subtitle={`${number(cart.count)} line(s) across ${number(cart.distributorCount)} distributor(s)`}
        actions={
          cart.count > 0 && (
            <button type="button" className="btn-secondary" onClick={cart.clear} disabled={busy}>
              <Trash2 className="h-4 w-4" aria-hidden />
              Clear cart
            </button>
          )
        }
      />

      {created.length > 0 && (
        <div className="card mb-5 border-l-4 border-l-emerald-500 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">
                {created.length} simulated purchase order{created.length > 1 ? 's' : ''} created
              </p>
              <ul className="mt-2 space-y-1">
                {created.map((order) => (
                  <li key={order.id} className="text-sm text-slate-600">
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:text-brand-800"
                      onClick={() => navigate(`/procurement/orders/${order.id}`)}
                    >
                      {order.po_number}
                    </button>{' '}
                    — {order.distributor_name}, {currency(order.total_amount)}
                    {order.free_units > 0 && ` including ${order.free_units} free units`}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                These orders exist only in your local database. Nothing has been transmitted to any
                distributor or external platform. Receive the goods from the Purchase Orders screen
                to create batches and move stock.
              </p>
            </div>
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="card mb-5 border-l-4 border-l-rose-500 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-slate-900">Some orders could not be created</p>
              <ul className="mt-1 list-inside list-disc text-sm text-slate-600">
                {errors.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">
                Those lines are still in your cart. A common cause is a distributor's minimum order
                value not being met.
              </p>
            </div>
          </div>
        </div>
      )}

      {cart.byDistributor.map((group) => {
        const groupTotals = group.lines.reduce(
          (acc, line) => {
            const priced = priceCartLine(line);
            return { net: acc.net + priced.net, free: acc.free + priced.freeQty, savings: acc.savings + priced.savings };
          },
          { net: 0, free: 0, savings: 0 },
        );

        return (
          <Card
            key={group.distributorId}
            className="mb-4"
            bodyClassName="p-0"
            title={group.distributorName}
            subtitle={`${group.lines.length} line(s) · one purchase order`}
            actions={
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => cart.clearDistributor(group.distributorId)}
              >
                Remove all
              </button>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50/70">
                    <th className="th">Product</th>
                    <th className="th text-right">Qty</th>
                    <th className="th text-right">PTR</th>
                    <th className="th">Scheme</th>
                    <th className="th text-right">Free</th>
                    <th className="th text-right">Net</th>
                    <th className="th text-right">Effective</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody>
                  {group.lines.map((line) => {
                    const priced = priceCartLine(line);
                    const short = line.availableQty > 0 && line.quantity > line.availableQty;
                    return (
                      <tr key={`${line.productId}-${line.distributorId}`} className="table-row">
                        <td className="td max-w-[260px]">
                          <span className="block truncate font-medium text-slate-800">{line.productName}</span>
                          <span className="text-xs text-slate-500">
                            {line.packSize ?? ''} · added from {line.addedFrom}
                          </span>
                        </td>
                        <td className="td text-right">
                          <input
                            type="number"
                            min={1}
                            aria-label={`Quantity for ${line.productName}`}
                            className="input w-20 py-1 text-right"
                            value={line.quantity}
                            onChange={(e) =>
                              cart.update(line.productId, line.distributorId, {
                                quantity: Math.max(1, Number(e.target.value) || 1),
                              })
                            }
                          />
                          {short && (
                            <span className="mt-0.5 block text-[11px] text-amber-600">
                              only {line.availableQty} listed
                            </span>
                          )}
                        </td>
                        <td className="td text-right tnum">{currency(line.ptr, 2)}</td>
                        <td className="td">
                          <Pill tone={line.schemeLabel === 'No scheme' ? 'slate' : 'emerald'}>
                            {line.schemeLabel}
                          </Pill>
                        </td>
                        <td className="td text-right tnum text-emerald-600">
                          {priced.freeQty > 0 ? `+${priced.freeQty}` : '—'}
                        </td>
                        <td className="td text-right tnum">{currency(priced.net)}</td>
                        <td className="td text-right tnum font-medium">
                          {currency(priced.effectiveCost, 2)}
                        </td>
                        <td className="td text-right">
                          <button
                            type="button"
                            className="btn-ghost px-2 py-1"
                            aria-label={`Remove ${line.productName}`}
                            onClick={() => cart.remove(line.productId, line.distributorId)}
                          >
                            <Trash2 className="h-4 w-4 text-slate-400" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-3 text-sm">
              <span className="text-slate-600">
                {groupTotals.free > 0 && (
                  <>
                    <strong className="text-emerald-600">{groupTotals.free} free units</strong> ·{' '}
                  </>
                )}
                estimated saving {currency(groupTotals.savings)}
              </span>
              <span className="font-semibold text-slate-900 tnum">{currency(groupTotals.net)}</span>
            </div>
          </Card>
        );
      })}

      {cart.count > 0 && (
        <Card className="sticky bottom-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <dl className="flex flex-wrap gap-x-8 gap-y-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Units</dt>
                <dd className="text-lg font-semibold tnum text-slate-900">{number(cartTotals.units)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Free goods</dt>
                <dd className="text-lg font-semibold tnum text-emerald-600">{number(cartTotals.free)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Estimated saving</dt>
                <dd className="text-lg font-semibold tnum text-emerald-600">{currency(cartTotals.savings)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Order total</dt>
                <dd className="text-lg font-semibold tnum text-slate-900">{currency(cartTotals.net)}</dd>
              </div>
            </dl>

            <button type="button" className="btn-primary" onClick={createOrders} disabled={busy}>
              <Truck className="h-4 w-4" aria-hidden />
              {busy
                ? 'Creating…'
                : `Create ${cart.distributorCount} purchase order${cart.distributorCount > 1 ? 's' : ''}`}
            </button>
          </div>

          <div className="mt-3 flex items-start gap-2 border-t border-slate-100 pt-3">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <p className="text-xs leading-relaxed text-slate-500">
              Totals here are an estimate computed in the browser. When you create the order the
              server re-prices every line from the distributor's own catalogue, so the purchase
              order carries the authoritative figures. Orders are <strong>simulated</strong> — they
              are written to your local database only and are never transmitted anywhere.
            </p>
          </div>
        </Card>
      )}
    </>
  );
}
