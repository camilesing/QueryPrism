import { joinBridgeTables } from './join-path';
import type { TableRelationEdge } from './m-schema.builder';

const e = (
  fromTable: string,
  fromField: string,
  toTable: string,
  toField: string,
): TableRelationEdge => ({ fromTable, fromField, toTable, toField });

// orders —(user_id)→ users, orders —(product_id)→ products,
// products —(category_id)→ categories, payments —(order_id)→ orders
const edges = [
  e('orders', 'user_id', 'users', 'id'),
  e('orders', 'product_id', 'products', 'id'),
  e('products', 'category_id', 'categories', 'id'),
  e('payments', 'order_id', 'orders', 'id'),
];

describe('joinBridgeTables (MetaDataImprove M3)', () => {
  it('finds the table connecting two seeds within 2 hops (either edge direction)', () => {
    // users and products share only the connector orders
    expect(joinBridgeTables(edges, ['users', 'products'])).toEqual(['orders']);
    // reversed storage direction still connects (FK graph is undirected)
    expect(joinBridgeTables(edges, ['users', 'payments'])).toEqual(['orders']);
  });

  it('returns [] when the seeds are directly joined (no mid needed)', () => {
    expect(joinBridgeTables(edges, ['orders', 'users'])).toEqual([]);
  });

  it('does not treat a one-seed neighbor as a bridge', () => {
    // categories only hangs off products — not a connector between seeds
    expect(
      joinBridgeTables(edges, ['users', 'products', 'categories']),
    ).toEqual(['orders']);
  });

  it('needs at least two seeds', () => {
    expect(joinBridgeTables(edges, ['users'])).toEqual([]);
    expect(joinBridgeTables(edges, [])).toEqual([]);
  });

  it('filters bridges through the universe (checked tables)', () => {
    // orders hidden from the LLM → no eligible connector
    expect(
      joinBridgeTables(edges, ['users', 'products'], ['users', 'products']),
    ).toEqual([]);
  });

  it('ignores self-edges and malformed empty names', () => {
    const messy = [...edges, e('x', 'a', 'x', 'b'), e('', 'a', 'y', 'b')];
    expect(joinBridgeTables(messy, ['users', 'products'])).toEqual(['orders']);
  });
});
