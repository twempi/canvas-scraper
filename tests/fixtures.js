// Synthetic content only. These are API fixtures, never real account/course data.
import { ORIGIN } from '../extension/script/canvas.js';
export const course = { id: '1', name: 'Synthetic Circuit Analysis', code: 'TEST101', term: { name: 'Synthetic term', end_at: '2099-01-01T00:00:00Z' } };
export function response(value, { status = 200, headers = {}, url = ORIGIN, raw = false } = {}) {
  const result = new Response(raw ? value : JSON.stringify(value), { status, headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...headers } });
  Object.defineProperty(result,'url',{ value: url }); return result;
}
export function fixtures({ filesDenied = false, assignmentsDenied = false, modulesDenied = false, changed = false } = {}) {
  const requests = [], routes = new Map(), binary = new Map();
  const file = (id,name,extra={}) => ({ id, filename: name, display_name: name, size: 7, updated_at: changed ? '2026-10-02' : '2026-10-01', 'content-type': 'application/pdf', url: `${ORIGIN}/files/${id}/download?verifier=fake-secret`, folder_id: 21, ...extra });
  const files = [file(7,'Lecture notes.pdf'),file(8,'Lab data.csv'),file(11,'../Résumé : notes.pdf'),file(99,'Restricted reference guide.pdf',{ locked_for_user: true })];
  routes.set('/api/v1/users/self/profile',{ id: 100, name: 'Synthetic API user' });
  routes.set('/api/v1/courses',[course,{...course,id:'2',name:'Synthetic Statistics',code:'TEST202'}]);
  routes.set('/api/v1/courses/1/modules',[{ id: 2, position: 1, name: 'Introduction / theory' }]);
  routes.set('/api/v1/courses/1/modules?page=2',[{ id: 2, position: 1, name: 'Introduction / theory' },{ id: 3, position: 2, name: 'Practice' }]);
  routes.set('/api/v1/courses/1/modules/2/items',[
    { type: 'Page', page_url: 'start', title: 'Start here' },{ type: 'File',content_id: 7,title:'Lecture' },{ type: 'Assignment',content_id:9,title:'Worksheet' },
    { type: 'Quiz', content_id:30, title:'Quiz description' },{ type: 'Discussion',content_id:20,title:'Discussion prompt' },{ type: 'ExternalTool',title:'External lab',html_url:`${ORIGIN}/courses/1/external_tools/5?access_token=fake-secret` },{ type:'File',content_id:99,title:'Restricted guide' }
  ]);
  routes.set('/api/v1/courses/1/modules/3/items',[{ type:'Page',page_url:'123',title:'Page alias' },{ type:'File',content_id:7,title:'Repeated lecture' },{ type:'File',content_id:199,title:'Forbidden handout' }]);
  routes.set('/api/v1/courses/1/pages/start',{ page_id:123,url:'start',title:'Getting started',body:'<p>Synthetic instructions.</p><a href="/courses/1/files/7/download?download_frd=1&verifier=fake-secret">Lecture</a><a href="/courses/1/pages/other">Next</a><a href="https://www.youtube.com/watch?v=synthetic&access_token=fake-secret">Video</a><script><a href="/files/777">Bad</a></script>' });
  routes.set('/api/v1/courses/1/pages/123',routes.get('/api/v1/courses/1/pages/start'));
  routes.set('/api/v1/courses/1/pages/other',{ page_id:124,url:'other',title:'More notes',body:'<a href="/courses/1/pages/start">Back</a><a href="/courses/2/pages/foreign">Other course</a><iframe src="https://colab.research.google.com/drive/synthetic?token=fake-secret"></iframe>' });
  const assignments = [{ id:9,name:'Worksheet',description:'<p>Synthetic worksheet.</p><a href="/courses/1/files/7">Lecture</a>' },{ id:10,name:'Independent assignment',description:'<a href="/files/8">Data</a>' }];
  assignments.forEach(a=>routes.set(`/api/v1/courses/1/assignments/${a.id}`,a));
  routes.set('/api/v1/courses/1/assignments',assignments);
  routes.set('/api/v1/courses/1/discussion_topics/20',{ id:20,title:'Discussion prompt',message:'<p>Synthetic prompt only.</p>' });
  routes.set('/api/v1/courses/1/quizzes/30',{ id:30,title:'Quiz description',description:'<p>Synthetic description only.</p>' });
  routes.set('/api/v1/courses/1/files',files);
  files.forEach(f=>{ routes.set(`/api/v1/courses/1/files/${f.id}`,f); binary.set(`/files/${f.id}/download`,'lecture'); });
  routes.set('/api/v1/courses/1/folders',[{ id:20,name:'course files',parent_folder_id:null },{ id:21,name:'Notes : PDFs',parent_folder_id:20 }]);
  const fetcher = async (input, options) => {
    const url = new URL(input); requests.push({ path:url.pathname, page:url.searchParams.get('page'), method: options?.method || 'GET', credentials: options?.credentials });
    if (url.pathname.includes('/files/') && url.pathname.endsWith('/download')) return response(binary.get(url.pathname) || 'lecture',{ raw:true,headers:{'Content-Type':'application/pdf'},url:url.href });
    if (filesDenied && url.pathname === '/api/v1/courses/1/files' || assignmentsDenied && url.pathname === '/api/v1/courses/1/assignments' || modulesDenied && url.pathname === '/api/v1/courses/1/modules') return response({errors:[{message:'restricted'}]},{status:403,url:url.href});
    const key = url.pathname + (url.searchParams.get('page') === '2' ? '?page=2' : '');
    if (!routes.has(key)) return response({errors:[{message:'unavailable'}]},{ status:403,url:url.href });
    const headers = url.pathname === '/api/v1/courses/1/modules' && !url.searchParams.has('page') ? { Link:`<${ORIGIN}/api/v1/courses/1/modules?page=2&per_page=100>; rel="next"` } : {};
    return response(routes.get(key),{ url:url.href,headers });
  };
  return { fetcher, requests, routes, binary, file };
}
export class MemoryStore {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.get(key); }
  async set(key,value) { this.data.set(key,value); }
  async delete(key) { this.data.delete(key); }
}
