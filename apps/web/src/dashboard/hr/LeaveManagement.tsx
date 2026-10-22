// src/dashboard/hr/LeaveManagement.tsx
// NOTE: This component intentionally avoids TanStack Query so it can be mounted
// inside a plain client bundle (see LeaveRequestList). Keep fetch logic here in
// sync with src/hooks/useLeaveRequests.ts (unwrapApiResponse semantics).
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card';
import { Button } from '@/shared/ui/Button';
import { Badge } from '@/shared/ui/Badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/Tabs';
import {
  Calendar,
  Clock,
  CheckCircle,
  XCircle,
  Plus,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '@/features/auth/hooks';
import { apiService } from '@/lib/api/client';
import { API_ENDPOINTS } from '@/lib/api/endpoints';
import { toast } from 'sonner';
import { LeaveApprovalModal } from '@/dashboard/hr/LeaveApprovalModal';
import type {
  LeaveRequest as ModalLeaveRequest,
  ApprovalStatus,
} from '@/types/leave';

export interface LeaveRequest {
  id: string;
  employee?: {
    id?: string;
    userId?: string;
    user?: { id?: string; name?: string; email?: string };
  };
  leaveType: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason?: string;
  emergencyContact?: string;
  status: string;
  managerApproval: string;
  hrApproval: string;
  managerId?: string;
  manager?: { id?: string; userId?: string; user?: { id?: string; name?: string } | null };
  backupEmployee?: { id?: string; firstName?: string; lastName?: string } | null;
}

// Narrowing guard: only the three documented approval states are valid in the
// modal's canonical type. Anything unexpected falls back to 'PENDING' so the
// modal's stage logic stays conservative (an unknown stage is treated as not
// yet actioned rather than silently APPROVED/REJECTED).
function asApprovalStatus(value: string | undefined): ApprovalStatus {
  return value === 'APPROVED' || value === 'REJECTED' ? value : 'PENDING';
}

// Typed adapter from the dashboard's raw API representation to the modal's
// canonical LeaveRequest (@/types/leave). Preserves every field the modal
// renders or uses for approval decisions: id, dates, totals, reason,
// emergency contact, backup employee display name, and the three approval
// statuses. No data needed for approvals or display is discarded.
export function toModalLeave(leave: LeaveRequest): ModalLeaveRequest {
  const backup = leave.backupEmployee;
  const backupName = backup
    ? [backup.firstName, backup.lastName].filter(Boolean).join(' ').trim()
    : '';
  return {
    id: leave.id,
    employee: {
      name: leave.employee?.user?.name || 'Unknown Employee',
      email: leave.employee?.user?.email || '',
    },
    leaveType: { name: leave.leaveType },
    totalDays: leave.totalDays,
    startDate: leave.startDate,
    endDate: leave.endDate,
    reason: leave.reason ?? null,
    emergencyContact: leave.emergencyContact ?? null,
    backupEmployee: backup ? { id: backup.id, name: backupName } : null,
    managerApproval: asApprovalStatus(leave.managerApproval),
    hrApproval: asApprovalStatus(leave.hrApproval),
    status: asApprovalStatus(leave.status),
  };
}

// The API returns { status: 'success', leaves: [...], pagination } — NOT `.data`.
// Mirrors unwrapApiResponse() in src/hooks/useLeaveRequests.ts.
export function extractLeaves(payload: any): LeaveRequest[] {
  const body = payload?.data ?? payload;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.leaves)) return body.leaves;
  if (Array.isArray(body?.data?.leaves)) return body.data.leaves;
  return [];
}

const PAGE_LIMIT = 100;

const LeaveManagement = () => {
  const { user } = useAuth();

  const [showRequestForm, setShowRequestForm] = useState(false);
  const [selectedLeave, setSelectedLeave] = useState<LeaveRequest | null>(null);
  const [approvalRole, setApprovalRole] = useState<'manager' | 'hr'>('hr');
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('all');
  const [decisionInProgress, setDecisionInProgress] = useState(false);

  const leaveStats = useMemo(() => {
    const pending = leaveRequests.filter(l => l.status === 'PENDING').length;
    const approved = leaveRequests.filter(l => l.status === 'APPROVED').length;
    const rejected = leaveRequests.filter(l => l.status === 'REJECTED').length;

    return {
      pendingRequests: pending,
      approvedRequests: approved,
      rejectedRequests: rejected,
      totalRequests: leaveRequests.length
    };
  }, [leaveRequests]);

  const filteredLeaves = useMemo(() => {
    switch (activeTab) {
      case 'pending':
        return leaveRequests.filter(l => l.status === 'PENDING');
      case 'approved':
        return leaveRequests.filter(l => l.status === 'APPROVED');
      case 'rejected':
        return leaveRequests.filter(l => l.status === 'REJECTED');
      default:
        return leaveRequests;
    }
  }, [activeTab, leaveRequests]);

  // Fetch leave data (server defaults to limit=10 — request an explicit page size
  // and read `.leaves` from the { status, leaves, pagination } envelope).
  const loadLeaveData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const response = await apiService.get(API_ENDPOINTS.hr.leaveRequests.list, {
        params: { page: 1, limit: PAGE_LIMIT },
      });

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to load leave requests');
      }

      setLeaveRequests(extractLeaves(response.data));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load leave requests');
      toast.error('Failed to load leave requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLeaveData();
  }, [loadLeaveData]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getStatusBadge = (status: string) => {
    const variants = {
      PENDING: 'bg-yellow-100 text-yellow-800',
      APPROVED: 'bg-green-100 text-green-800',
      REJECTED: 'bg-red-100 text-red-800',
    };
    
    return (
      <Badge className={variants[status as keyof typeof variants] || 'bg-gray-100 text-gray-800'}>
        {status}
      </Badge>
    );
  };

  const getApprovalStatus = (approval?: string) => {
    if (!approval) return null;
    
    const variants = {
      PENDING: 'bg-gray-100 text-gray-800',
      APPROVED: 'bg-green-100 text-green-800',
      REJECTED: 'bg-red-100 text-red-800',
    };
    
    return (
      <Badge className={variants[approval as keyof typeof variants] || 'bg-gray-100 text-gray-800'}>
        {approval}
      </Badge>
    );
  };

  // Manager approval is only allowed for the assigned manager, compared by user ID
  // (never by display name), and never on one's own request.
  const canApproveAsManager = (leave: LeaveRequest) => {
    return !!user &&
           leave.managerApproval === 'PENDING' &&
           leave.status === 'PENDING' &&
           !!leave.manager?.user?.id &&
           leave.manager.user.id === user.id &&
           leave.employee?.userId !== user.id;
  };

  const canApproveAsHr = (leave: LeaveRequest) => {
    return !!user && (user.role === 'hr_manager' || user.role === 'hr_staff') &&
           leave.managerApproval === 'APPROVED' &&
           leave.hrApproval === 'PENDING';
  };

  const openApprovalModal = (leave: LeaveRequest) => {
    setSelectedLeave(leave);
    // HR takes precedence only when the HR stage is actually actionable;
    // otherwise fall back to the manager stage so it is never skipped.
    setApprovalRole(canApproveAsHr(leave) ? 'hr' : 'manager');
    setShowApprovalModal(true);
  };

  const handleDecision = async (leaveId: string, status: 'APPROVED' | 'REJECTED', comments: string) => {
    // The modal supplies the ID of the leave it is displaying. Verify it
    // matches the selected record before submitting — never act on a stale or
    // mismatched ID.
    if (!selectedLeave || leaveId !== selectedLeave.id) return;
    // Prevent duplicate submissions while an approval/rejection is in flight.
    if (decisionInProgress) return;
    setDecisionInProgress(true);
    try {
      const url = approvalRole === 'hr'
        ? API_ENDPOINTS.hr.leaveRequests.approve.hr(selectedLeave.id)
        : API_ENDPOINTS.hr.leaveRequests.approve.manager(selectedLeave.id);

      // The API schema expects { status, comments } — not `approvalStatus`.
      const response = await apiService.patch(url, { status, comments });

      if (!response.success) {
        throw new Error(
          response.error?.message ||
          response.data?.error ||
          'Failed to update leave request'
        );
      }

      toast.success(`Leave request ${status.toLowerCase()} successfully`);
      setShowApprovalModal(false);
      setSelectedLeave(null);
      await loadLeaveData();
    } catch (err) {
      // Surface the failure WITHOUT closing the modal — the operation did not
      // succeed and the reviewer may retry or cancel explicitly.
      toast.error(err instanceof Error ? err.message : 'Failed to update leave request');
    } finally {
      setDecisionInProgress(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Leave Management</h1>
        <Button onClick={() => setShowRequestForm(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Leave Request
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Requests</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{leaveStats.pendingRequests}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Approved (Total)</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{leaveStats.approvedRequests}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rejected (Total)</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{leaveStats.rejectedRequests}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{leaveStats.totalRequests}</div>
          </CardContent>
        </Card>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {loadError}{' '}
          <button className="underline" onClick={loadLeaveData}>Retry</button>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="all">All Requests</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Leave Requests</CardTitle>
            </CardHeader>
            <CardContent>
              {filteredLeaves.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground">No leave requests found</div>
              ) : (
                <div className="space-y-4">
                  {filteredLeaves.map((leave) => (
                    <div key={leave.id} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="space-y-1">
                        <div className="font-semibold flex items-center gap-2">
                          {leave.employee?.user?.name || 'Unknown Employee'}
                          <Badge variant="outline">{leave.leaveType}</Badge>
                        </div>
                        <div className="text-sm text-muted-foreground flex items-center gap-2">
                          <Calendar className="h-3 w-3" />
                          {formatDate(leave.startDate)} - {formatDate(leave.endDate)}
                          <span className="text-xs bg-gray-100 px-2 py-0.5 rounded-full">
                            {leave.totalDays} days
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right text-sm">
                          <div className="flex items-center gap-2 justify-end mb-1">
                            <span className="text-muted-foreground text-xs">Manager:</span>
                            {getApprovalStatus(leave.managerApproval)}
                          </div>
                          <div className="flex items-center gap-2 justify-end">
                            <span className="text-muted-foreground text-xs">HR:</span>
                            {getApprovalStatus(leave.hrApproval)}
                          </div>
                        </div>
                        
                        {(canApproveAsManager(leave) || canApproveAsHr(leave)) && (
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => openApprovalModal(leave)}>
                              Review
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Approval Modal (Radix Dialog: focus trap, ESC, backdrop) */}
      <LeaveApprovalModal
        leave={selectedLeave ? toModalLeave(selectedLeave) : null}
        isOpen={showApprovalModal}
        onClose={() => {
          setShowApprovalModal(false);
          setSelectedLeave(null);
        }}
        onApprove={(id, comments) => handleDecision(id, 'APPROVED', comments)}
        onReject={(id, comments) => handleDecision(id, 'REJECTED', comments)}
        isLoading={decisionInProgress}
        userRole={approvalRole}
      />
    </div>
  );
};

export default LeaveManagement;