-- Search functions for the isolated RAG v2 table.
CREATE OR REPLACE FUNCTION public.match_rag_chunks_brand_v2(
  p_query_embedding vector,
  p_match_count integer,
  p_filter_brand text
)
RETURNS TABLE(
  id text, file_id text, file_name text, folder_path text, brand text,
  web_url text, chunk_index integer, content text, tokens integer,
  method text, readable integer, modified text, document_type text,
  rag_priority integer, score double precision
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH brand_pool AS (
    SELECT * FROM public.rag_chunks_v2 rc
    WHERE p_filter_brand IS NOT NULL
      AND upper(trim(rc.brand)) = upper(trim(p_filter_brand))
    LIMIT 1000
  )
  SELECT bp.id, bp.file_id, bp.file_name, bp.folder_path, bp.brand,
    bp.web_url, bp.chunk_index, bp.content, bp.tokens, bp.method,
    bp.readable, bp.modified, bp.document_type, bp.rag_priority,
    1 - (bp.embedding <=> p_query_embedding) AS score
  FROM brand_pool bp
  ORDER BY bp.embedding <=> p_query_embedding
  LIMIT greatest(p_match_count, 1);
$$;

CREATE OR REPLACE FUNCTION public.match_rag_chunks_code_brand_v2(
  p_error_code text,
  p_filter_brand text,
  p_match_count integer
)
RETURNS TABLE(
  id text, file_id text, file_name text, folder_path text, brand text,
  web_url text, chunk_index integer, content text, tokens integer,
  method text, readable integer, modified text, document_type text,
  rag_priority integer, score double precision
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH candidate_files AS (
    SELECT DISTINCT rc.file_id
    FROM public.rag_chunks_v2 rc
    WHERE upper(trim(rc.brand)) = upper(trim(p_filter_brand))
      AND (
        upper(rc.file_name) LIKE '%' || upper(p_error_code) || '%'
        OR upper(rc.file_name) IN ('GFS050307.PDF', 'GFS050307_FR.PDF')
      )
    LIMIT 20
  ), candidate_chunks AS (
    SELECT rc.*
    FROM public.rag_chunks_v2 rc
    JOIN candidate_files cf ON cf.file_id = rc.file_id
    WHERE upper(trim(rc.brand)) = upper(trim(p_filter_brand))
      AND rc.chunk_index BETWEEN 14 AND 25
  )
  SELECT rc.id, rc.file_id, rc.file_name, rc.folder_path, rc.brand,
    rc.web_url, rc.chunk_index, rc.content, rc.tokens, rc.method,
    rc.readable, rc.modified, rc.document_type, rc.rag_priority,
    CASE WHEN upper(rc.content) LIKE '%' || upper(p_error_code) || '%'
      THEN 3.0 ELSE 2.0 END AS score
  FROM candidate_chunks rc
  ORDER BY CASE WHEN upper(rc.content) LIKE '%' || upper(p_error_code) || '%'
    THEN 0 ELSE 1 END, rc.chunk_index ASC
  LIMIT greatest(p_match_count, 1);
$$;

REVOKE ALL ON FUNCTION public.match_rag_chunks_brand_v2(vector,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_rag_chunks_code_brand_v2(text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_rag_chunks_brand_v2(vector,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_rag_chunks_code_brand_v2(text,text,integer) TO service_role;
