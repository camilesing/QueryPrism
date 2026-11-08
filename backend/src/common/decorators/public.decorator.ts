// Metadata keys + decorators for marking routes public (exempt from auth)
// and declaring the audit-log config consumed by the SystemLogInterceptor.
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Mark a route (or controller) as not requiring a JWT. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
