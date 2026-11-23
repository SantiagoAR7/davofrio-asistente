-- Compact exact-code lookup for the large v2 corpus. This avoids sequential
-- ILIKE scans over more than 650k chunks during interactive diagnostics.
CREATE TABLE IF NOT EXISTS public.rag_error_codes_v2 (
  brand text NOT NULL,
  error_code text NOT NULL,
  chunk_id text NOT NULL REFERENCES public.rag_chunks_v2(id) ON DELETE CASCADE,
  PRIMARY KEY (brand, error_code, chunk_id)
);

INSERT INTO public.rag_error_codes_v2 (brand, error_code, chunk_id)
SELECT DISTINCT
  rc.brand,
  regexp_replace((matches.parts)[1], '[- _]', '', 'g') AS error_code,
  rc.id
FROM public.rag_chunks_v2 rc
CROSS JOIN LATERAL regexp_matches(
  upper(rc.content),
  '(?:^|[^A-Z0-9])([A-Z]{1,3}[- _]?[0-9]{1,3})(?:$|[^A-Z0-9])',
  'g'
) AS matches(parts)
WHERE rc.brand IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS rag_error_codes_v2_code_brand_idx
  ON public.rag_error_codes_v2 (error_code, brand);

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
  SELECT rc.id, rc.file_id, rc.file_name, rc.folder_path, rc.brand,
    rc.web_url, rc.chunk_index, rc.content, rc.tokens, rc.method,
    rc.readable, rc.modified, rc.document_type, rc.rag_priority,
    3.0::double precision AS score
  FROM public.rag_error_codes_v2 ec
  JOIN public.rag_chunks_v2 rc ON rc.id = ec.chunk_id
  WHERE ec.error_code = regexp_replace(upper(p_error_code), '[- _]', '', 'g')
    AND (p_filter_brand IS NULL OR upper(trim(ec.brand)) = upper(trim(p_filter_brand)))
  ORDER BY rc.rag_priority DESC, rc.file_name, rc.chunk_index
  LIMIT greatest(p_match_count, 1);
$$;

REVOKE ALL ON TABLE public.rag_error_codes_v2 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.rag_error_codes_v2 TO service_role;
REVOKE ALL ON FUNCTION public.match_rag_chunks_code_brand_v2(text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_rag_chunks_code_brand_v2(text,text,integer) TO service_role;
