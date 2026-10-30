// apps/api/src/modules/hr/leave.controller.ts
import { Request, Response } from 'express';
import prisma from '../../utils/prisma';
import { LeaveType, Prisma, LeaveStatus } from '@prisma/client';
import { z } from 'zod';
import { emailService } from '../../services/emailService';


// Validation schemas
const createLeaveSchema = z.object({
  leaveType: z.enum(['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'UNPAID', 'OTHER']),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  reason: z.string().optional(),
  emergencyContact: z.string().optional(),
  backupEmployeeId: z.string().optional(),
});

const updateLeaveStatusSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  comments: z.string().optional(),
});

const updateLeaveBalanceSchema = z.object({
  annualLeave: z.number().min(0),
  sickLeave: z.number().min(0),
  personalLeave: z.number().min(0),
});

export class LeaveController {
  // ========================================
  // ✅ PRIVATE HELPER METHODS FIRST
  // ========================================
  private readonly DEFAULT_ENTITLEMENTS = {
    annualLeave: 21,
    sickLeave: 10,
    personalLeave: 5,
  };

  private async calculateUsedLeaveDays(
    employeeId: string, 
    leaveType: LeaveType, 
    year?: number
  ): Promise<number> {
    try {
      const where: Prisma.LeaveWhereInput = {
        employeeId,
        leaveType,
        status: 'APPROVED',
      };

      if (year) {
        const startOfYear = new Date(year, 0, 1);
        const endOfYear = new Date(year + 1, 0, 1);
        where.startDate = { gte: startOfYear, lt: endOfYear };
      }

      const usedLeaves = await prisma.leave.findMany({
        where,
        select: { totalDays: true },
      });

      return usedLeaves.reduce((sum, leave) => sum + (leave.totalDays || 0), 0);
    } catch (error) {
      console.error('Error calculating used leave days:', error);
      return 0;
    }
  }

  private mapBalanceTypeToLeaveType(balanceType: string): LeaveType | null {
    switch (balanceType) {
      case 'annualLeave': return 'ANNUAL';
      case 'sickLeave': return 'SICK';
      case 'personalLeave': return 'OTHER';
      default: return null;
    }
  }

  private async getEmployeeLeaveBalance(
    employeeId: string, 
    balanceType: string, 
    year?: number
  ) {
    try {
      let dbBalance: any = null;
      try {
        dbBalance = await (prisma as any).leaveBalance?.findUnique({
          where: { employeeId },
        });
      } catch (err) {
        console.log('LeaveBalance model not found, using defaults');
      }

      const leaveType = this.mapBalanceTypeToLeaveType(balanceType);
      let totalDays = 0;
      let usedDays = 0;

      switch (balanceType) {
        case 'annualLeave':
          totalDays = dbBalance?.annualLeave ?? this.DEFAULT_ENTITLEMENTS.annualLeave;
          break;
        case 'sickLeave':
          totalDays = dbBalance?.sickLeave ?? this.DEFAULT_ENTITLEMENTS.sickLeave;
          break;
        case 'personalLeave':
          totalDays = dbBalance?.personalLeave ?? this.DEFAULT_ENTITLEMENTS.personalLeave;
          break;
        default:
          totalDays = 0;
      }

      if (leaveType && year) {
        usedDays = await this.calculateUsedLeaveDays(employeeId, leaveType, year);
      }

      return {
        total: totalDays,
        used: usedDays,
        remaining: Math.max(0, totalDays - usedDays),
      };
    } catch (error) {
      console.error('Error fetching leave balance:', error);
      return { total: 0, used: 0, remaining: 0 };
    }
  }

  private async getCurrentYearLeaveBalance(employeeId: string) {
    const currentYear = new Date().getFullYear();
    const annualBalance = await this.getEmployeeLeaveBalance(employeeId, 'annualLeave', currentYear);
    const sickBalance = await this.getEmployeeLeaveBalance(employeeId, 'sickLeave', currentYear);
    const personalBalance = await this.getEmployeeLeaveBalance(employeeId, 'personalLeave', currentYear);

    return {
      annualLeave: annualBalance,
      sickLeave: sickBalance,
      personalLeave: personalBalance,
    };
  }

  // ========================================
  // ✅ PUBLIC ROUTE HANDLERS
  // ========================================

  /**
   * Submit a leave request (Employee)
   * POST /hr/leave-requests
   */
  createLeaveRequest = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.sub;
      const data = createLeaveSchema.parse(req.body);

      const employee = await prisma.employee.findUnique({
        where: { userId },
        include: { manager: true, user: true },
      });

      if (!employee) {
        return res.status(404).json({ error: 'Employee profile not found' });
      }

      const startDate = new Date(data.startDate);
      const endDate = new Date(data.endDate);
      const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      const currentYear = startDate.getFullYear();
      
      // Map leave type to balance type
      let balanceType = '';
      switch (data.leaveType) {
        case 'ANNUAL': balanceType = 'annualLeave'; break;
        case 'SICK': balanceType = 'sickLeave'; break;
        case 'OTHER': balanceType = 'personalLeave'; break;
        default: balanceType = 'annualLeave';
      }
      
      const leaveBalance = await this.getEmployeeLeaveBalance(employee.id, balanceType, currentYear);
      
      if (leaveBalance.remaining < totalDays) {
        return res.status(400).json({ 
          error: `Insufficient leave balance. Available: ${leaveBalance.remaining} days` 
        });
      }

      // Get default HR staff
      const defaultHr = await prisma.user.findFirst({
        where: { role: { in: ['hr_manager', 'hr_staff'] } },
        include: { employee: true }
      });

      const leaveRequest = await prisma.leave.create({
        data: {
          employeeId: employee.id,
          leaveType: data.leaveType,
          startDate,
          endDate,
          totalDays,
          reason: data.reason,
          emergencyContact: data.emergencyContact,
          requestedBy: userId,
          status: 'PENDING',
          managerApproval: 'PENDING',
          hrApproval: 'PENDING',
          managerId: employee.managerId || '',
          hrId: defaultHr?.employee?.id || '',
          approvedBy: '',
          ...(data.backupEmployeeId && { backupEmployeeId: data.backupEmployeeId }),
        },
        include: {
          employee: { include: { user: { select: { id: true, name: true, email: true } } } },
          backupEmployee: true,
        },
      });

      // Notify manager
      if (employee.managerId) {
        await (prisma as any).notification?.create({
          data: {
            userId: employee.managerId,
            type: 'INFO',
            title: 'New Leave Request',
            message: `${employee.user.name} has requested ${totalDays} days of ${data.leaveType} leave`,
          },
        });

        await emailService.sendNotificationEmail(employee.managerId, 'LEAVE_REQUEST', {
          leaveType: data.leaveType,
          duration: totalDays,
          employeeName: employee.user.name,
        });
      }

      res.status(201).json({ status: 'success', leaveRequest });
    } catch (error) {
      console.error('Error creating leave request:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to create leave request' });
    }
  };

  /**
   * Get all leave requests with filtering
   * GET /hr/leave-requests
   */
  getLeaveRequests = async (req: Request, res: Response) => {
    try {
      const { status, employeeId, leaveType, startDate, endDate, page = 1, limit = 10 } = req.query;
      const userId = (req as any).user?.sub;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { employee: true },
      });

      if (!user) return res.status(404).json({ error: 'User not found' });

      const where: Prisma.LeaveWhereInput = {};

      if (user.role === 'customer') {
        where.employeeId = user.employee?.id;
      } else if (user.role === 'driver' || user.role === 'warehouse') {
        where.OR = [
          { employeeId: user.employee?.id },
          { managerId: user.employee?.id },
        ];
      }
      // HR/admin can see all

      if (status) where.status = status as LeaveStatus;
      if (employeeId) where.employeeId = employeeId as string;
      if (leaveType) where.leaveType = leaveType as LeaveType;
      if (startDate) where.startDate = { gte: new Date(startDate as string) };
      if (endDate) where.endDate = { lte: new Date(endDate as string) };

      const skip = (Number(page) - 1) * Number(limit);

      const [leaves, total] = await Promise.all([
        prisma.leave.findMany({
          where,
          include: {
            employee: { include: { user: { select: { id: true, name: true, email: true } } } },
            manager: { include: { user: { select: { id: true, name: true, email: true } } } },
            hr: { include: { user: { select: { id: true, name: true, email: true } } } },
            backupEmployee: true,
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: Number(limit),
        }),
        prisma.leave.count({ where }),
      ]);

      res.json({
        status: 'success',
        leaves,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      console.error('Error fetching leave requests:', error);
      res.status(500).json({ error: 'Failed to fetch leave requests' });
    }
  };

  /**
   * Get leave request by ID
   * GET /hr/leave-requests/:id
   */
  getLeaveRequestById = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.sub;

      const leave = await prisma.leave.findUnique({
        where: { id },
        include: {
          employee: { include: { user: { select: { id: true, name: true, email: true } } } },
          manager: { include: { user: { select: { id: true, name: true, email: true } } } },
          hr: { include: { user: { select: { id: true, name: true, email: true } } } },
          backupEmployee: true,
        },
      });

      if (!leave) return res.status(404).json({ error: 'Leave request not found' });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { employee: true },
      });

      if (!user) return res.status(404).json({ error: 'User not found' });

      const canView = 
        user.role === 'admin' ||
        leave.employeeId === user.employee?.id ||
        leave.managerId === user.employee?.id ||
        user.role === 'hr_manager' ||
        user.role === 'hr_staff';

      if (!canView) {
        return res.status(403).json({ error: 'Permission denied' });
      }

      res.json({ status: 'success', leave });
    } catch (error) {
      console.error('Error fetching leave request:', error);
      res.status(500).json({ error: 'Failed to fetch leave request' });
    }
  };

  /**
   * Manager approves/rejects leave request
   * PATCH /hr/leave-requests/:id/manager-approval
   */
  updateManagerApproval = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.sub;
      const { status, comments } = updateLeaveStatusSchema.parse(req.body);

      const manager = await prisma.employee.findUnique({
        where: { userId },
        include: { user: true },
      });

      if (!manager) return res.status(404).json({ error: 'Manager profile not found' });

      const leave = await prisma.leave.findUnique({
        where: { id },
        include: { employee: { include: { user: { select: { id: true, name: true, email: true } } } } },
      });

      if (!leave) return res.status(404).json({ error: 'Leave request not found' });
      // A manager must never approve their own leave request.
      if (leave.employeeId === manager.id) {
        return res.status(403).json({ error: 'Managers cannot approve their own leave requests' });
      }
      if (leave.managerId !== manager.id) {
        return res.status(403).json({ error: 'Not authorized to approve this request' });
      }
      if (leave.managerApproval !== 'PENDING') {
        return res.status(400).json({ error: 'Request already processed' });
      }

      const updatedLeave = await prisma.leave.update({
        where: { id },
        data: {
          managerApproval: status,
          managerApprovedAt: status === 'APPROVED' ? new Date() : null,
          managerComments: comments,
        },
        include: {
          employee: { include: { user: { select: { id: true, name: true, email: true } } } },
          manager: { include: { user: { select: { id: true, name: true, email: true } } } },
        },
      });

      // Notify employee
      await (prisma as any).notification?.create({
        data: {
          userId: leave.employee.userId,
          type: 'INFO',
          title: `Leave Request ${status}`,
          message: `Your leave request has been ${status.toLowerCase()} by your manager`,
        },
      });

      await emailService.sendNotificationEmail(leave.employee.userId, 'LEAVE_STATUS', {
        status,
        comments,
        approverName: manager.user.name,
      });

      res.json({ status: 'success', updatedLeave });
    } catch (error) {
      console.error('Error updating manager approval:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to update manager approval' });
    }
  };

  /**
   * HR approves/rejects leave request
   * PATCH /hr/leave-requests/:id/hr-approval
   */
  updateHrApproval = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.sub;
      const { status, comments } = updateLeaveStatusSchema.parse(req.body);

      const hr = await prisma.employee.findUnique({
        where: { userId },
        include: { user: true },
      });

      if (!hr) return res.status(404).json({ error: 'HR profile not found' });

      const leave = await prisma.leave.findUnique({
        where: { id },
        include: { employee: { include: { user: { select: { id: true, name: true, email: true } } } } },
      });

      if (!leave) return res.status(404).json({ error: 'Leave request not found' });
      if (leave.managerApproval !== 'APPROVED') {
        return res.status(400).json({ error: 'Manager approval required first' });
      }
      if (leave.hrApproval !== 'PENDING') {
        return res.status(400).json({ error: 'Request already processed by HR' });
      }

      const updatedLeave = await prisma.$transaction(async (tx) => {
        const updated = await tx.leave.update({
          where: { id },
          data: {
            hrApproval: status,
            hrApprovedAt: status === 'APPROVED' ? new Date() : null,
            hrComments: comments,
            status: status === 'APPROVED' ? 'APPROVED' : 'REJECTED',
            ...(status === 'APPROVED' && { approvedBy: hr.id, approvedAt: new Date() }),
            ...(status === 'REJECTED' && { rejectedBy: hr.id, rejectedAt: new Date(), rejectionReason: comments }),
          },
          include: {
            employee: { include: { user: { select: { id: true, name: true, email: true } } } },
            hr: { include: { user: { select: { id: true, name: true, email: true } } } },
          },
        });

        // Update balance if approved
        if (status === 'APPROVED') {
          try {
            const leaveBalance = await (tx as any).leaveBalance?.findUnique({
              where: { employeeId: leave.employeeId },
            });

            if (leaveBalance) {
              await (tx as any).leaveBalance?.update({
                where: { employeeId: leave.employeeId },
                data: {
                  annualLeave: leaveBalance.annualLeave - (leave.leaveType === 'ANNUAL' ? leave.totalDays : 0),
                  sickLeave: leaveBalance.sickLeave - (leave.leaveType === 'SICK' ? leave.totalDays : 0),
                  personalLeave: leaveBalance.personalLeave - (leave.leaveType === 'OTHER' ? leave.totalDays : 0),
                },
              });
            }
          } catch (err) {
            console.log('LeaveBalance model not found, skipping balance update');
          }
        }

        return updated;
      });

      // Notify employee
      await (prisma as any).notification?.create({
        data: {
          userId: leave.employee.userId,
          type: 'INFO',
          title: `Leave Request ${status}`,
          message: `Your leave request has been ${status.toLowerCase()} by HR`,
        },
      });

      await emailService.sendNotificationEmail(leave.employee.userId, 'LEAVE_STATUS', {
        status,
        comments,
        approverName: 'HR Team',
      });

      res.json({ status: 'success', updatedLeave });
    } catch (error) {
      console.error('Error updating HR approval:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to update HR approval' });
    }
  };

  /**
 * Get employee leave balance by ID
 * GET /hr/leave-balance/:employeeId?
 */
getEmployeeLeaveBalanceById = async (req: Request, res: Response) => {
  try {
    const { employeeId } = req.params;
    const userId = (req as any).user?.sub;

    console.log('=== Leave Balance Request Debug ===');
    console.log('Request params:', req.params);
    console.log('EmployeeId from params:', employeeId);
    console.log('User ID from token:', userId);

    // Get current user with employee profile
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { employee: true },
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!currentUser.employee) {
      return res.status(404).json({ error: 'Employee profile not found for this user' });
    }

    console.log('Current user role:', currentUser.role);
    console.log('Current user employee ID:', currentUser.employee.id);

    // Determine which employee's balance to fetch
    let targetEmployeeId: string;
    
    // CASE 1: No employeeId provided in URL
    // Example: GET /api/hr/leave-balance
    if (!employeeId) {
      // Always return the current user's own balance
      targetEmployeeId = currentUser.employee.id;
      console.log('No employeeId provided - fetching current user balance');
    }
    // CASE 2: employeeId provided in URL
    // Example: GET /api/hr/leave-balance/some-user-id
    else {
      targetEmployeeId = employeeId;
      console.log('EmployeeId provided - checking permissions for:', employeeId);
      
      // Check if user has permission to view this specific employee
      const isSelf = currentUser.employee.id === employeeId;
      const isAdmin = currentUser.role === 'admin';
      const isHRManager = currentUser.role === 'hr_manager';
      const isHRStaff = currentUser.role === 'hr_staff';
      const isExecutive = ['ceo' ].includes(currentUser.role);
      
      const hasPermission = isSelf || isAdmin || isHRManager || isHRStaff || isExecutive;
      
      console.log('Permission check:', {
        isSelf,
        isAdmin,
        isHRManager,
        isHRStaff,
        isExecutive,
        hasPermission
      });
      
      if (!hasPermission) {
        return res.status(403).json({ 
          error: 'Permission denied',
          message: 'You can only view your own leave balance'
        });
      }
    }

    // Fetch the leave balance for the target employee
      console.log('Fetching leave balance for employee ID:', targetEmployeeId);
      const currentYearBalance = await this.getCurrentYearLeaveBalance(targetEmployeeId);
    
    console.log('Leave balance fetched:', currentYearBalance);

    // Return response wrapped in data property as expected by frontend
    return res.json({ 
      status: 'success', 
      data: currentYearBalance
    });
    
  } catch (error) {
    console.error('Error fetching leave balance:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch leave balance',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

  /**
   * Update employee leave balance (Admin/HR only)
   * PATCH /hr/leave-balance/:employeeId
   */
  updateEmployeeLeaveBalance = async (req: Request, res: Response) => {
    try {
      const { employeeId } = req.params;
      const data = updateLeaveBalanceSchema.parse(req.body);

      let existing = null;
      try {
        existing = await (prisma as any).leaveBalance?.findUnique({ where: { employeeId } });
      } catch (err) {
        console.log('LeaveBalance model not found');
      }

      let updated: any = null;
      if (existing) {
        updated = await (prisma as any).leaveBalance?.update({ where: { employeeId }, data });
      } else {
        try {
          updated = await (prisma as any).leaveBalance?.create({ data: { employeeId, ...data } });
        } catch (err) {
          updated = { employeeId, ...data };
        }
      }

      res.json({ status: 'success', updated });
    } catch (error) {
      console.error('Error updating leave balance:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to update leave balance' });
    }
  };

  /**
   * Delete leave request
   * DELETE /hr/leave-requests/:id
   */
  deleteLeaveRequest = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.sub;

      const leave = await prisma.leave.findUnique({
        where: { id },
        include: { employee: { include: { user: { select: { id: true, name: true, email: true } } } } },
      });

      if (!leave) return res.status(404).json({ error: 'Leave request not found' });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { employee: true },
      });

      if (!user) return res.status(404).json({ error: 'User not found' });

      const canDelete = 
        user.role === 'admin' ||
        user.role === 'hr_manager' ||
        user.role === 'hr_staff' ||
        leave.employeeId === user.employee?.id;

      if (!canDelete) return res.status(403).json({ error: 'Permission denied' });
      if (leave.status === 'APPROVED') {
        return res.status(400).json({ error: 'Cannot delete approved requests' });
      }

      await prisma.leave.delete({ where: { id } });

      res.json({ status: 'success', message: 'Leave request deleted' });
    } catch (error) {
      console.error('Error deleting leave request:', error);
      res.status(500).json({ error: 'Failed to delete leave request' });
    }
  };

  /**
   * Get available approvers for leave requests
   * GET /hr/leaves/approvers
   */
  getLeaveApprovers = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.sub;
      
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get current user's employee record for context-aware filtering
      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        include: { employee: true },
      });

      if (!currentUser) {
        return res.status(404).json({ error: 'User profile not found' });
      }

      // Fetch managers: users with manager role OR who have direct reports
      const managers = await prisma.employee.findMany({
        where: {
          OR: [
            { user: { role: 'hr_manager' } },
            { subordinates: { some: {} } },
          ],
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
        orderBy: { user: { name: 'asc' } },
      });

      // Fetch HR staff: users with HR-related roles
      const hrStaff = await prisma.user.findMany({
        where: {
          role: { in: ['hr_manager', 'hr_staff', 'admin'] },
        },
        include: {
          employee: true,
        },
        orderBy: { name: 'asc' },
      });

      // Fetch potential backup employees: same department, not self, active
      const backupEmployees = await prisma.employee.findMany({
        where: {
          AND: [
            currentUser.employee?.departmentId 
              ? { departmentId: currentUser.employee.departmentId } 
              : {},
            { id: { not: currentUser.employee?.id } },
            { userId: { not: userId } },
          ],
        },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
        take: 50, // Performance limit
        orderBy: { user: { name: 'asc' } },
      });

      // Format response to match frontend expectations
      res.json({
        status: 'success',
        data: {
          managers: managers.map(m => ({
            id: m.id,
            name: m.user?.name || 'Unknown',
            email: m.user?.email,
            departmentId: m.departmentId,
            role: m.user?.role, 
          })),
          hrStaff: hrStaff.map(hr => ({
            id: hr.employee?.id || hr.id,
            name: hr.name,
            email: hr.email,
            role: hr.role,
            departmentId: hr.employee?.departmentId,
          })),
          backupEmployees: backupEmployees.map(e => ({
            id: e.id,
            name: e.user?.name || 'Unknown',
            email: e.user?.email,
            departmentId: e.departmentId,
          })),
        },
      });
    } catch (error) {
      console.error('Error fetching leave approvers:', error);
      
      // Return graceful fallback in production
      if (process.env.NODE_ENV === 'production') {
        return res.status(500).json({ 
          error: 'Unable to fetch approvers',
          message: 'Please try again later or contact support'
        });
      }
      
      // Detailed error in development
      return res.status(500).json({ 
        error: 'Failed to fetch approvers',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  };

  /**
   * Get available leave types with employee-specific balances
   * GET /hr/leave-types
   */
  getLeaveTypes = async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.sub;
      
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get employee record
      const employee = await prisma.employee.findUnique({
        where: { userId },
      });

      if (!employee) {
        return res.status(404).json({ error: 'Employee profile not found' });
      }

      // Define leave types configuration (sync with frontend expectations)
      const leaveTypesConfig = [
        { id: 'ANNUAL', name: 'Annual Leave', daysPerYear: 21, requiresDocumentation: false, description: 'Planned time off for vacation or personal matters' },
        { id: 'SICK', name: 'Sick Leave', daysPerYear: 10, requiresDocumentation: true, description: 'Medical leave for illness or injury' },
        { id: 'MATERNITY', name: 'Maternity Leave', daysPerYear: 90, requiresDocumentation: true, description: 'Leave for childbirth and recovery' },
        { id: 'PATERNITY', name: 'Paternity Leave', daysPerYear: 14, requiresDocumentation: false, description: 'Leave for new fathers' },
        { id: 'UNPAID', name: 'Unpaid Leave', daysPerYear: null, requiresDocumentation: false, description: 'Extended leave without pay (subject to approval)' },
        { id: 'OTHER', name: 'Personal Leave', daysPerYear: 5, requiresDocumentation: false, description: 'Other personal circumstances' },
      ] as const;

      const currentYear = new Date().getFullYear();
      
      // Calculate balances for each leave type
      const leaveTypesWithBalance = await Promise.all(
        leaveTypesConfig.map(async (type) => {
          const usedDays = await this.calculateUsedLeaveDays(
            employee.id, 
            type.id as LeaveType, 
            currentYear
          );
          
          const totalDays = type.daysPerYear ?? 0;
          const remainingDays = totalDays > 0 ? Math.max(0, totalDays - usedDays) : null;

          return {
            id: type.id,
            name: type.name,
            description: type.description,
            daysPerYear: type.daysPerYear,
            remainingDays,
            usedDays,
            requiresDocumentation: type.requiresDocumentation,
            // Additional metadata for frontend
            color: this.getLeaveTypeColor(type.id),
            icon: this.getLeaveTypeIcon(type.id),
          };
        })
      );

      res.json({
        status: 'success',
        data: leaveTypesWithBalance,
        meta: {
          year: currentYear,
          employeeId: employee.id,
          lastUpdated: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('Error fetching leave types:', error);
      
      if (process.env.NODE_ENV === 'production') {
        return res.status(500).json({ 
          error: 'Unable to fetch leave types',
          message: 'Please try again later'
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to fetch leave types',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  };

  // ========================================
  // ✅ PRIVATE HELPER METHODS (Normal methods - called via `this` internally)
  // ========================================

  /**
   * Get display color for leave type (for frontend badges)
   */
  private getLeaveTypeColor(leaveType: LeaveType): string {
    const colors: Record<LeaveType, string> = {
      ANNUAL: 'blue',
      SICK: 'red',
      MATERNITY: 'pink',
      PATERNITY: 'purple',
      UNPAID: 'gray',
      OTHER: 'orange',
    };
    return colors[leaveType] || 'gray';
  }

  /**
   * Get icon identifier for leave type (for frontend icons)
   */
  private getLeaveTypeIcon(leaveType: LeaveType): string {
    const icons: Record<LeaveType, string> = {
      ANNUAL: 'calendar',
      SICK: 'health',
      MATERNITY: 'baby',
      PATERNITY: 'baby',
      UNPAID: 'clock',
      OTHER: 'star',
    };
    return icons[leaveType] || 'star';
  }
}