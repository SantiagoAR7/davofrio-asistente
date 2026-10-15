-- Execute once in Supabase SQL Editor. No existing rows are removed by this migration.
CREATE OR REPLACE FUNCTION public.replace_rag_file(p_file_id text, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE inserted integer;
BEGIN
  IF p_file_id IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'A nonempty file replacement is required';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE r->>'file_id' IS DISTINCT FROM p_file_id
      OR length(coalesce(r->>'content','')) = 0 OR (r->>'tokens')::int > 350) THEN
    RAISE EXCEPTION 'Invalid chunks';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_file_id,0));
  DELETE FROM public.rag_chunks WHERE file_id = p_file_id;
  INSERT INTO public.rag_chunks (id,file_id,file_name,folder_path,brand,web_url,chunk_index,content,tokens,embedding,method,readable,modified,document_type,rag_priority)
  SELECT id,file_id,file_name,folder_path,brand,web_url,chunk_index,content,tokens,embedding,method,readable,modified,document_type,rag_priority
  FROM jsonb_populate_recordset(NULL::public.rag_chunks, p_rows);
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;
REVOKE ALL ON FUNCTION public.replace_rag_file(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_rag_file(text,jsonb) TO service_role;

-- These indexes keep file replacement and brand-filtered retrieval fast.
CREATE INDEX IF NOT EXISTS rag_chunks_file_id_idx
  ON public.rag_chunks (file_id);
CREATE INDEX IF NOT EXISTS rag_chunks_brand_file_id_idx
  ON public.rag_chunks (brand, file_id);

CREATE OR REPLACE FUNCTION public.rag_index_stats()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  -- Exact aggregation times out once the vector table contains hundreds of
  -- thousands of rows. PostgreSQL's maintained row estimate is immediate and
  -- sufficiently accurate for the administration status panel.
  SELECT jsonb_build_object(
    'total', NULL,
    'chunks', GREATEST(c.reltuples, 0)::bigint,
    'indexedAt', NULL,
    'brands', '[]'::jsonb
  )
  FROM pg_class c
  WHERE c.oid = 'public.rag_chunks'::regclass;
$$;
REVOKE ALL ON FUNCTION public.rag_index_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_index_stats() TO service_role;
