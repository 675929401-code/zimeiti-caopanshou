import { withExtractionExactlyOnce } from '@/lib/extraction-exactly-once';
import { handleCozeExtraction } from '@/lib/coze-extraction-handler';
export const maxDuration = 300;
export const POST = withExtractionExactlyOnce('coze', request => handleCozeExtraction(request));
