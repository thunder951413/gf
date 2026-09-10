# Retrieval v2 post-hoc correction

This is a bounded post-hoc implementation created after reviewing the frozen v1 results. It must be reported as a correction, not as the original held-out score. `retrieval.mjs`, its tests, and all saved v1/model evidence remain unchanged.

V2 repairs generic implementation defects: it preserves Han single characters and creates bigrams across `Intl.Segmenter` boundaries; treats declared keywords and rare exact body terms as tiered lexical evidence; splits Chinese and ASCII sentence-final punctuation; downranks non-asserted raw questions when a factual record from the same topic is available; and recognizes a short utterance containing a continuation marker after conservative supported assistant use.

The broader exact-term gate trades some precision for recall. Common conversational and question terms are filtered, metadata keywords receive the strongest treatment, and rare body terms use document frequency. Short user questions remain available as conversational history but cannot displace a supported factual record in the same topic.

This remains lexical retrieval. It intentionally contains no mappings for evaluation phrases, locations, postcard wording, floating sensations, or other held-out examples. Synonyms, hypernyms, entailment, contradiction, and multi-entity correction scope remain known limitations.
