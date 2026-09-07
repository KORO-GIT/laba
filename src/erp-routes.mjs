import { z } from 'zod';
import { config } from './config.mjs';
import { fail } from './erp-database.mjs';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = (max) => z.string().trim().min(1).max(max);
const note = z.string().trim().max(2000).default('');
const steps = z.array(z.object({ title: text(120), instructions: note, plannedMinutes: z.number().int().min(0).max(1440).default(0) }).strict()).min(1).max(20);
const selected = z.array(z.object({ id, version: id }).strict()).min(1).max(500).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Повторні ідентифікатори');
const receipt = { reference: text(160), serials: z.array(text(120)).max(500), unnumbered: z.number().int().min(0).max(500).default(0) };
const roles = ['admin','manager','warehouse','technician','inspector','observer'];
const managers = ['admin','manager'];
const schemas = {
  client: z.object({ name: text(160), contact: z.string().trim().max(200).default(''), notes: note }).strict(),
  template: z.object({ name: text(160), steps }).strict(),
  order: z.object({ clientId: id, title: text(160), model: text(120), kind: z.enum(['repair','upgrade','service']), priority: z.enum(['normal','high','urgent']), dueDate: z.iso.date().nullable().default(null), notes: note, templateId: id.nullable().default(null), steps, ...receipt }).strict(),
  receipt: z.object(receipt).strict(),
  assign: z.object({ userId: id, tasks: selected }).strict(),
  task: z.object({ action: z.enum(['start','pause','block','complete']), version: id, note }).strict(),
  shift: z.object({ action: z.enum(['start','pause','resume','end']), version: id.optional() }).strict(),
  quality: z.object({ result: z.enum(['pass','rework']), version: id, note, taskId: id.optional() }).strict(),
  delivery: z.object({ reference: text(160), recipient: text(160), units: selected }).strict(),
  stock: z.object({ sku: text(100), name: text(160), clientId: id.nullable().default(null), condition: z.enum(['new','good','unknown','defective']), shelf: z.string().trim().max(100).default(''), reference: text(160), originUnitId: id.nullable().default(null), quantity: z.number().int().min(1).max(1000000) }).strict(),
  move: z.object({ from: z.enum(['warehouse','workbench','installed']), to: z.enum(['warehouse','workbench','installed','returned','scrap']), unitId: id.nullable().default(null), quantity: z.number().int().min(1).max(1000000), note: text(500) }).strict(),
  member: z.object({ role: z.enum(['none',...roles]) }).strict(),
  newMember: z.object({ name: text(120), email: z.email().max(254), role: z.enum(['manager','warehouse','technician','inspector','observer']) }).strict(),
  orderUpdate: z.object({title:text(160),priority:z.enum(['normal','high','urgent']),dueDate:z.iso.date().nullable(),notes:note,version:id}).strict(),
  closeShift: z.object({version:id,endedAt:z.number().int().positive(),reason:text(500)}).strict()
};

export function registerErpRoutes(app, erp) {
  const allowed = (roles) => async request => erp.requireRole(request.portalUser, roles);
  const numericId = (request) => {
    const parsed = z.coerce.number().int().positive().safeParse(request.params.id);
    if (!parsed.success) fail(400, 'Некоректний ідентифікатор');
    return parsed.data;
  };
  app.get('/erp', { preHandler: allowed(roles) }, async (request, reply) => reply.sendFile('erp.html', { maxAge: 0, immutable: false }));
  app.get('/api/erp/context', { preHandler: allowed(roles), config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: request => `erp-read:${request.portalUser?.id ?? request.ip}` } } }, async request => {
    const query=z.object({taskState:z.enum(['all','open','pending','in_progress','paused','blocked','done']).default('all'),q:z.string().max(120).default(''),page:z.coerce.number().int().min(0).max(100000).default(0)}).strict().safeParse(request.query);
    if(!query.success)fail(400,'Некоректні параметри пошуку');
    return erp.snapshot(request.portalUser,query.data);
  });
  app.get('/api/erp/orders/:id', { preHandler: allowed(roles.filter(r => r !== 'technician')) }, async request => erp.orderDetail(request.portalUser, numericId(request)));
  app.get('/api/erp/stock/:id/history', { preHandler: allowed(['admin','manager','warehouse','observer']) }, async request => erp.stockHistory(request.portalUser, numericId(request)));
  app.get('/api/erp/members/:id/shifts', { preHandler: allowed(['admin','manager','observer']) }, async request => erp.memberShifts(request.portalUser,numericId(request)));

  function write(path, schema, access, action) {
    app.post(`/api/erp/${path}`, {
      bodyLimit: 256 * 1024,
      preHandler: [allowed(access), async request => {
        const expected = config.nodeEnv === 'production' ? `https://${config.baseDomain}` : `http://${request.headers.host}`;
        if (request.headers.origin !== expected || request.headers['x-portal-request'] !== '1'
          || ['cross-site','same-site'].includes(request.headers['sec-fetch-site'])) fail(403, 'Запит відхилено захистом CSRF');
        if (!z.uuid().safeParse(request.headers['x-erp-request-id']).success) fail(400, 'Потрібен унікальний ідентифікатор операції');
      }],
      config: { rateLimit: { max: 90, timeWindow: '1 minute', keyGenerator: request => `erp-write:${request.portalUser?.id ?? request.ip}` } }
    }, async request => {
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) fail(400, `Перевірте поля: ${parsed.error.issues.map(i => i.path.join('.')).slice(0,5).join(', ')}`);
      try {
        return erp.command(request.portalUser, request.headers['x-erp-request-id'], request.url, parsed.data, () => action(request.portalUser, parsed.data, request.params.id ? numericId(request) : null));
      } catch (error) {
        if (String(error.code).startsWith('SQLITE_CONSTRAINT')) fail(409, 'Операція конфліктує з обліком: перевірте дублікати номерів, назви та поточний стан');
        throw error;
      }
    });
  }
  write('clients', schemas.client, managers, (u,b) => erp.createClient(u,b));
  write('templates', schemas.template, managers, (u,b) => erp.createTemplate(u,b));
  write('orders', schemas.order, managers, (u,b) => erp.createOrder(u,b));
  write('orders/:id/receive', schemas.receipt, [...managers,'warehouse'], (u,b,id) => erp.receiveUnits(u,id,b));
  write('assign', schemas.assign, managers, (u,b) => erp.assign(u,b));
  write('tasks/:id/action', schemas.task, [...managers,'technician'], (u,b,id) => erp.taskAction(u,id,b));
  write('shifts/action', schemas.shift, [...managers,'technician'], (u,b) => erp.shiftAction(u,b));
  write('units/:id/quality', schemas.quality, [...managers,'inspector'], (u,b,id) => erp.quality(u,id,b));
  write('orders/:id/deliver', schemas.delivery, [...managers,'warehouse'], (u,b,id) => erp.deliver(u,id,b));
  write('stock', schemas.stock, [...managers,'warehouse'], (u,b) => erp.receiveStock(u,b));
  write('stock/:id/move', schemas.move, [...managers,'warehouse','technician'], (u,b,id) => erp.moveStock(u,id,b));
  write('members/:id', schemas.member, ['admin'], (u,b,id) => erp.setMember(u,id,b));
  write('members', schemas.newMember, ['admin'], (u,b) => erp.createMember(u,b));
  write('members/:id/close-shift', schemas.closeShift, managers, (u,b,id) => erp.closeMemberShift(u,id,b));
  write('orders/:id/update', schemas.orderUpdate, managers, (u,b,id) => erp.updateOrder(u,id,b));
}
