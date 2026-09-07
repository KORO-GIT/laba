import { z } from 'zod';
import { config } from './config.mjs';
import { fail } from './erp-database.mjs';
import {MAX_GUIDE_UPLOAD,normalizeGuideImage} from './erp-guide-images.mjs';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = (max) => z.string().trim().min(1).max(max);
const note = z.string().trim().max(2000).default('');
const steps = z.array(z.object({ title: text(120), instructions: note, plannedMinutes: z.number().int().min(0).max(1440).default(0) }).strict()).min(1).max(20);
const selected = z.array(z.object({ id, version: id }).strict()).min(1).max(500).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Повторні ідентифікатори');
const receipt = { reference: text(160), serials: z.array(text(120)).max(500), unnumbered: z.number().int().min(0).max(500).default(0) };
const roles = ['admin','manager','warehouse','technician','inspector','observer'];
const managers = ['admin','manager'];
const taskQuery = z.object({taskState:z.enum(['all','open','pending','in_progress','paused','blocked','done']).default('all'),q:z.string().max(120).default(''),page:z.coerce.number().int().min(0).max(100000).default(0)}).strict();
const crewFields = {name:text(100),description:note,leadId:id,members:z.array(id).min(1).max(50).refine(values=>new Set(values).size===values.length,'Повторні учасники')};
const quantity=z.number().positive().max(1000000);
const materialFields={sku:text(100),name:text(160),uom:z.enum(['pcs','m','g','ml']),minimum:z.number().min(0).max(1000000),target:z.number().min(0).max(1000000)};
const specSchema=z.object({version:z.number().int().min(0),lines:z.array(z.object({materialId:id,quantity,source:z.enum(['workshop','client'])}).strict()).max(40).refine(lines=>new Set(lines.map(l=>`${l.materialId}:${l.source}`)).size===lines.length,'Повторні матеріали')}).strict();
const replenishmentFields={quantity,note:text(500)};
const guideFields={title:text(160),summary:z.string().trim().max(500).default(''),category:z.string().trim().max(80).default(''),model:z.string().trim().max(120).default(''),publish:z.boolean().default(false),
  steps:z.array(z.object({title:z.string().trim().max(120),text:z.string().trim().max(6000),imageId:z.uuid().nullable().default(null),caption:z.string().trim().max(300).default('')}).strict()).min(1).max(30)};
const schemas = {
  client: z.object({ name: text(160), contact: z.string().trim().max(200).default(''), notes: note }).strict(),
  template: z.object({ name: text(160), steps }).strict(),
  order: z.object({ clientId: id, title: text(160), model: text(120), kind: z.enum(['repair','upgrade','service']), priority: z.enum(['normal','high','urgent']), dueDate: z.iso.date().nullable().default(null), notes: note, templateId: id.nullable().default(null), steps, ...receipt }).strict(),
  receipt: z.object(receipt).strict(),
  assign: z.object({ userId: id, tasks: selected }).strict(),
  task: z.object({ action: z.enum(['start','pause','block','complete','finish_part']), version: id, note }).strict(),
  crew:z.object(crewFields).strict(),
  crewUpdate:z.object({...crewFields,archived:z.boolean(),version:id}).strict(),
  crewAssign:z.object({crewId:id,mode:z.enum(['pool','shared']),tasks:selected}).strict(),
  shift: z.object({ action: z.enum(['start','pause','resume','end']), version: id.optional() }).strict(),
  quality: z.object({ result: z.enum(['pass','rework']), version: id, note, taskId: id.optional() }).strict(),
  delivery: z.object({ reference: text(160), recipient: text(160), units: selected }).strict(),
  stock: z.object({ sku: text(100), name: text(160), materialId:id.nullable().default(null),replenishmentId:id.nullable().default(null),clientId: id.nullable().default(null), condition: z.enum(['new','good','unknown','defective']), shelf: z.string().trim().max(100).default(''), reference: text(160), originUnitId: id.nullable().default(null), quantity }).strict(),
  move: z.object({ from: z.enum(['warehouse','workbench','installed']), to: z.enum(['warehouse','workbench','installed','returned','scrap']), unitId: id.nullable().default(null), quantity, note: text(500) }).strict(),
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
  app.get('/api/erp/tasks/:id/work-history', { preHandler:allowed(roles.filter(r=>r!=='technician')) }, async request=>erp.workHistory(request.portalUser,numericId(request)));
  app.get('/api/erp/replenishments',{preHandler:allowed([...managers,'warehouse','observer'])},async request=>{
    const query=z.object({page:z.coerce.number().int().min(0).max(100000).default(0)}).strict().safeParse(request.query);
    if(!query.success)fail(400,'Некоректна сторінка заявок');
    return erp.replenishments(request.portalUser,query.data);
  });
  app.get('/api/erp/orders/:id/material-preview',{preHandler:allowed([...managers,'warehouse'])},async request=>{
    const parsed=z.object({units:z.string().min(1).max(8000).regex(/^\d+(,\d+)*$/)}).strict().safeParse(request.query);
    if(!parsed.success)fail(400,'Оберіть вироби');
    const ids=z.array(id).min(1).max(500).refine(values=>new Set(values).size===values.length).safeParse(parsed.data.units.split(',').map(Number));
    if(!ids.success)fail(400,'Оберіть до 500 різних виробів');
    return erp.previewConsumption(request.portalUser,numericId(request),ids.data);
  });
  app.get('/api/erp/crews/:id/tasks', { preHandler:allowed(['admin','manager','technician','observer']) }, async request=>{
    const parsed=taskQuery.safeParse(request.query);
    if(!parsed.success)fail(400,'Некоректні параметри пошуку');
    return erp.crewTasks(request.portalUser,numericId(request),parsed.data);
  });

  app.get('/api/erp/guides',{preHandler:allowed(roles)},async request=>{
    const query=z.object({q:z.string().max(120).default(''),page:z.coerce.number().int().min(0).max(100000).default(0),scope:z.enum(['published','draft','archived','all']).default('published')}).strict().safeParse(request.query);
    if(!query.success)fail(400,'Некоректний пошук інструкцій');return erp.guideList(request.portalUser,query.data);
  });
  app.get('/api/erp/guides/:id',{preHandler:allowed(roles)},async request=>{
    const query=z.object({draft:z.enum(['0','1']).default('0')}).strict().safeParse(request.query);
    if(!query.success)fail(400,'Некоректний запит інструкції');return erp.guideDetail(request.portalUser,numericId(request),query.data.draft==='1');
  });
  app.get('/api/erp/guides/:id/images/:imageId',{preHandler:allowed(roles)},async(request,reply)=>{
    if(!z.uuid().safeParse(request.params.imageId).success)fail(404,'Фото не знайдено');
    return reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Cross-Origin-Resource-Policy','same-origin').header('Content-Disposition','inline; filename="instruction.webp"').type('image/webp').send(erp.guideImage(request.portalUser,numericId(request),request.params.imageId));
  });

  function write(path, schema, access, action, options={}) {
    app.post(`/api/erp/${path}`, {
      bodyLimit: options.bodyLimit ?? 256 * 1024,
      preHandler: [allowed(access), async request => {
        const expected = config.nodeEnv === 'production' ? `https://${config.baseDomain}` : `http://${request.headers.host}`;
        if (request.headers.origin !== expected || request.headers['x-portal-request'] !== '1'
          || ['cross-site','same-site'].includes(request.headers['sec-fetch-site'])) fail(403, 'Запит відхилено захистом CSRF');
        if (!z.uuid().safeParse(request.headers['x-erp-request-id']).success) fail(400, 'Потрібен унікальний ідентифікатор операції');
      }],
      config: { rateLimit: { max: options.max ?? 90, timeWindow: '1 minute', keyGenerator: request => `${options.prepare?'erp-image':'erp-write'}:${request.portalUser?.id ?? request.ip}` } }
    }, async request => {
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) fail(400, `Перевірте поля: ${parsed.error.issues.map(i => i.path.join('.')).slice(0,5).join(', ')}`);
      try {
        const id=request.params.id?numericId(request):null;
        if(options.prepare){const previous=erp.replayCommand(request.portalUser,request.headers['x-erp-request-id'],request.url,parsed.data);if(previous)return previous.result;}
        const prepared=options.prepare?await options.prepare(request.portalUser,id,parsed.data):undefined;
        return erp.command(request.portalUser, request.headers['x-erp-request-id'], request.url, parsed.data, () => action(request.portalUser, parsed.data, id, prepared));
      } catch (error) {
        if (String(error.code).startsWith('SQLITE_CONSTRAINT')) fail(409, 'Операція конфліктує з обліком: перевірте дублікати номерів, назви та поточний стан');
        throw error;
      }
    });
  }
  write('guides',z.object(guideFields).strict(),['admin'],(u,b)=>erp.saveGuide(u,null,b));
  write('guides/:id',z.object({...guideFields,version:id}).strict(),['admin'],(u,b,id)=>erp.saveGuide(u,id,b));
  write('guides/:id/archive',z.object({version:id,archived:z.boolean()}).strict(),['admin'],(u,b,id)=>erp.archiveGuide(u,id,b));
  write('guides/:id/images',z.object({version:id,filename:z.string().min(1).max(160).regex(/^[^/\\\x00-\x1f]+\.(?:jpe?g|png|webp)$/i),data:z.string().min(4).max(4*Math.ceil(MAX_GUIDE_UPLOAD/3))}).strict(),['admin'],(u,b,id,image)=>erp.saveGuideImage(u,id,b,image),{
    bodyLimit:4*Math.ceil(MAX_GUIDE_UPLOAD/3)+1024,max:12,
    prepare:async(u,id,b)=>{erp.checkGuideUpload(u,id,b.version);return normalizeGuideImage(b);}
  });
  write('clients', schemas.client, managers, (u,b) => erp.createClient(u,b));
  write('templates', schemas.template, managers, (u,b) => erp.createTemplate(u,b));
  write('orders', schemas.order, managers, (u,b) => erp.createOrder(u,b));
  write('orders/:id/receive', schemas.receipt, [...managers,'warehouse'], (u,b,id) => erp.receiveUnits(u,id,b));
  write('assign', schemas.assign, managers, (u,b) => erp.assign(u,b));
  write('crews',schemas.crew,managers,(u,b)=>erp.saveCrew(u,null,b));
  write('crews/:id',schemas.crewUpdate,managers,(u,b,id)=>erp.saveCrew(u,id,b));
  write('assign-crew',schemas.crewAssign,managers,(u,b)=>erp.assignCrew(u,b));
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
  write('materials',z.object(materialFields).strict(),managers,(u,b)=>erp.saveMaterial(u,null,b));
  write('materials/:id',z.object({...materialFields,version:id}).strict(),managers,(u,b,id)=>erp.saveMaterial(u,id,b));
  write('templates/:id/materials',specSchema,managers,(u,b,id)=>erp.saveMaterialSpec(u,'template',id,b));
  write('orders/:id/materials',specSchema,managers,(u,b,id)=>erp.saveMaterialSpec(u,'order',id,b));
  write('stock/:id/link-material',z.object({materialId:id}).strict(),managers,(u,b,id)=>erp.linkMaterialLot(u,id,b));
  write('replenishments',z.object({...replenishmentFields,materialId:id,clientId:id.nullable().default(null)}).strict(),[...managers,'warehouse'],(u,b)=>erp.saveReplenishment(u,null,b));
  write('replenishments/:id',z.object({...replenishmentFields,version:id,cancel:z.boolean().default(false)}).strict(),[...managers,'warehouse'],(u,b,id)=>erp.saveReplenishment(u,id,b));
  write('orders/:id/consume-materials',z.object({specVersion:id,units:selected,note:text(400)}).strict(),[...managers,'warehouse'],(u,b,id)=>erp.consumeMaterials(u,id,b));
}
