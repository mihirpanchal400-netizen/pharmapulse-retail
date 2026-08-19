import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * PROCUREMENT CART
 * ================
 *
 * A working basket the pharmacist builds across screens - from the
 * Replenishment Center, from a supplier comparison, from a distributor
 * catalogue, or straight from a Mini Analyst recommendation - before committing
 * it as one or more purchase orders.
 *
 * Held client-side in localStorage rather than on the server, because a cart is
 * a draft, not a business record. Nothing is persisted to the database until
 * the user creates the purchase order, at which point the server does the real
 * scheme arithmetic and writes it.
 *
 * Lines are keyed by (product, distributor): the same product can legitimately
 * sit in the cart twice if it is being sourced from two distributors.
 */

export interface CartLine {
  productId: number;
  productName: string;
  productCode: string;
  packSize: string | null;
  distributorId: number;
  distributorName: string;
  quantity: number;
  ptr: number;
  schemeBuyQty: number;
  schemeFreeQty: number;
  discountPct: number;
  schemeLabel: string;
  /** Cost per unit received, as quoted when the line was added. */
  effectiveCost: number;
  availableQty: number;
  addedFrom: string;
}

interface CartContextValue {
  lines: CartLine[];
  count: number;
  /** Distinct distributors in the cart - each becomes its own purchase order. */
  distributorCount: number;
  add: (line: CartLine) => void;
  update: (productId: number, distributorId: number, patch: Partial<CartLine>) => void;
  remove: (productId: number, distributorId: number) => void;
  clear: () => void;
  clearDistributor: (distributorId: number) => void;
  has: (productId: number, distributorId?: number) => boolean;
  /** Lines grouped by distributor, ready to become purchase orders. */
  byDistributor: { distributorId: number; distributorName: string; lines: CartLine[] }[];
}

const STORAGE_KEY = 'pharmapulse.procurementCart';

const CartContext = createContext<CartContextValue | null>(null);

function load(): CartLine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // A full or disabled localStorage must not break the cart in memory.
    }
  }, [lines]);

  const add = useCallback((line: CartLine) => {
    setLines((current) => {
      const index = current.findIndex(
        (l) => l.productId === line.productId && l.distributorId === line.distributorId,
      );
      if (index === -1) return [...current, line];

      // Adding the same product from the same distributor tops up the quantity
      // rather than creating a duplicate line.
      const next = [...current];
      next[index] = { ...next[index], quantity: next[index].quantity + line.quantity };
      return next;
    });
  }, []);

  const update = useCallback((productId: number, distributorId: number, patch: Partial<CartLine>) => {
    setLines((current) =>
      current.map((l) =>
        l.productId === productId && l.distributorId === distributorId ? { ...l, ...patch } : l,
      ),
    );
  }, []);

  const remove = useCallback((productId: number, distributorId: number) => {
    setLines((current) =>
      current.filter((l) => !(l.productId === productId && l.distributorId === distributorId)),
    );
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const clearDistributor = useCallback((distributorId: number) => {
    setLines((current) => current.filter((l) => l.distributorId !== distributorId));
  }, []);

  const has = useCallback(
    (productId: number, distributorId?: number) =>
      lines.some(
        (l) => l.productId === productId && (distributorId === undefined || l.distributorId === distributorId),
      ),
    [lines],
  );

  const byDistributor = useMemo(() => {
    const groups = new Map<number, { distributorId: number; distributorName: string; lines: CartLine[] }>();
    for (const line of lines) {
      const group = groups.get(line.distributorId) ?? {
        distributorId: line.distributorId,
        distributorName: line.distributorName,
        lines: [],
      };
      group.lines.push(line);
      groups.set(line.distributorId, group);
    }
    return [...groups.values()];
  }, [lines]);

  const value = useMemo(
    () => ({
      lines,
      count: lines.length,
      distributorCount: byDistributor.length,
      add,
      update,
      remove,
      clear,
      clearDistributor,
      has,
      byDistributor,
    }),
    [lines, byDistributor, add, update, remove, clear, clearDistributor, has],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used inside a CartProvider.');
  return context;
}

/**
 * Free units earned under a buy/free scheme.
 * Mirrors the server's freeUnitsFor() so cart totals match what the purchase
 * order will actually be priced at.
 */
export function freeUnitsFor(quantity: number, buyQty: number, freeQty: number): number {
  if (!buyQty || !freeQty || quantity <= 0) return 0;
  return Math.floor(quantity / buyQty) * freeQty;
}

/** Line costing, matching the server's scheme engine. */
export function priceCartLine(line: CartLine) {
  const free = freeUnitsFor(line.quantity, line.schemeBuyQty, line.schemeFreeQty);
  const gross = line.quantity * line.ptr;
  const discount = gross * (line.discountPct / 100);
  const net = gross - discount;
  const totalUnits = line.quantity + free;
  return {
    freeQty: free,
    totalUnits,
    gross: Math.round(gross * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    net: Math.round(net * 100) / 100,
    effectiveCost: totalUnits > 0 ? Math.round((net / totalUnits) * 100) / 100 : 0,
    savings: Math.round((totalUnits * line.ptr - net) * 100) / 100,
  };
}
