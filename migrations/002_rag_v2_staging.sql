-- Creates an isolated RAG v2 target. The active rag_chunks table is untouched.
DO $$
BEGIN
  IF to_regclass('public.rag_chunks_v2') IS NULL THEN
    CREATE TABLE public.rag_chunks_v2
      (LIKE public.rag_chunks INCLUDING ALL);
  END IF;
END $$;

REVOKE ALL ON TABLE public.rag_chunks_v2 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_chunks_v2 TO service_role;

CREATE INDEX IF NOT EXISTS rag_chunks_v2_file_id_idx
  ON public.rag_chunks_v2 (file_id);
CREATE INDEX IF NOT EXISTS rag_chunks_v2_brand_file_id_idx
  ON public.rag_chunks_v2 (brand, file_id);

CREATE OR REPLACE FUNCTION public.replace_rag_file_v2(p_file_id text, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE inserted integer;
BEGIN
  IF p_file_id IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'A nonempty file replacement is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) r
    WHERE r->>'file_id' IS DISTINCT FROM p_file_id
      OR length(coalesce(r->>'content','')) = 0
      OR (r->>'tokens')::int > 350
  ) THEN
    RAISE EXCEPTION 'Invalid chunks';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rag_v2:' || p_file_id, 0));
  DELETE FROM public.rag_chunks_v2 WHERE file_id = p_file_id;
  INSERT INTO public.rag_chunks_v2
    (id,file_id,file_name,folder_path,brand,web_url,chunk_index,content,tokens,embedding,method,readable,modified,document_type,rag_priority)
  SELECT id,file_id,file_name,folder_path,brand,web_url,chunk_index,content,tokens,embedding,method,readable,modified,document_type,rag_priority
  FROM jsonb_populate_recordset(NULL::public.rag_chunks_v2, p_rows);
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;

REVOKE ALL ON FUNCTION public.replace_rag_file_v2(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_rag_file_v2(text,jsonb) TO service_role;
