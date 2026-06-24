/**
 * In-process SSE broadcaster. Single Node instance => an in-memory client set reaches
 * every connected client; no Redis Pub/Sub needed until we run >1 instance (see docs/03 §4).
 */
import type { FastifyReply } from 'fastify';

interface Client {
  reply: FastifyReply;
  supplierId?: string;
}

const clients = new Set<Client>();

export function addClient(reply: FastifyReply, supplierId?: string): Client {
  const c: Client = { reply, supplierId };
  clients.add(c);
  return c;
}

export function removeClient(c: Client) {
  clients.delete(c);
}

function write(c: Client, payload: object) {
  try {
    c.reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    clients.delete(c);
  }
}

export interface OrderUpdated {
  id: string;
  old_status: string;
  new_status: string;
  updated_at: string;
  supplier_id?: string;
}

export function broadcastOrderUpdated(o: OrderUpdated) {
  const payload = {
    type: 'order_updated',
    data: {
      id: o.id,
      old_status: o.old_status,
      new_status: o.new_status,
      updated_at: o.updated_at,
    },
  };
  for (const c of clients) {
    // Filtered subscribers only get their supplier's events; unfiltered get everything.
    if (c.supplierId && c.supplierId !== o.supplier_id) continue;
    write(c, payload);
  }
}

export function broadcastBulkCompleted(jobId: string) {
  const payload = { type: 'bulk_completed', data: { jobId } };
  for (const c of clients) write(c, payload);
}
