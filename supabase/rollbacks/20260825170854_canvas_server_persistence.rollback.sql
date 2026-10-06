begin;

drop function if exists public.delete_canvas_document_atomic(text,text,bigint,text,text);
drop function if exists public.save_canvas_document_atomic(text,text,bigint,text,text,text,text,jsonb);
drop table if exists public.canvas_document_requests;
drop table if exists public.canvas_documents;

commit;

