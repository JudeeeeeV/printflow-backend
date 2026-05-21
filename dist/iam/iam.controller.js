"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IamController = void 0;
const common_1 = require("@nestjs/common");
const supabase_auth_guard_1 = require("./guards/supabase-auth.guard");
const roles_guard_1 = require("./guards/roles.guard");
const roles_decorator_1 = require("./decorators/roles.decorator");
let IamController = class IamController {
    getClerkData(req) {
        return { message: 'Welcome to the Clerk Dashboard', user: req.user };
    }
};
exports.IamController = IamController;
__decorate([
    (0, common_1.Get)('clerk-dashboard'),
    (0, roles_decorator_1.Roles)('CLERK', 'MANAGER'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], IamController.prototype, "getClerkData", null);
exports.IamController = IamController = __decorate([
    (0, common_1.Controller)('iam'),
    (0, common_1.UseGuards)(supabase_auth_guard_1.SupabaseAuthGuard, roles_guard_1.RolesGuard)
], IamController);
//# sourceMappingURL=iam.controller.js.map