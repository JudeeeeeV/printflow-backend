import type { Request } from 'express';
export declare class IamController {
    getClerkData(req: Request): {
        message: string;
        user: any;
    };
}
