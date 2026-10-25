// src/dashboard/hr/LeaveManagement.tsx
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
import { LeaveApprovalModal } from './LeaveApprovalModal';
import type {
  ApprovalStatus,
  LeaveRequest as CanonicalLeaveRequest,
} from '@/types/leave';

/**
 * Raw leave record as returned by GET /hr/leave-requests (Prisma shape with
 * nested employee/manager/hr includes). This is the untrusted server payload;
 * everything rendered or submitted downstream goes through extractLeaves +
 * toModalLeave so the UI never depends on optional nested fields directly.
 */
export interface LeaveRequest {
  id: string;
  employeeId?: string;
  managerId?: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason?: string | null;
  emergencyContact?: string | null;
  status: string;
  managerApproval: string;
  hrApproval: string;
  leaveType: string | { name?: string; code?: string };
  employee?: {
    id?: string;
    userId?: string;
    user?: { id?: string; name?: string; email?: string } | null;
  } | null;
  manager?: {
    id?: string;
    userId?: string;
    user?: { id?: string; name?: string; email?: string } | null;
  } | null;
  backupEmployee?: { id?: string; user?: { name?: string } | null } | null;
}

const PAGE_LIMIT = 100;

const APPROVAL_VALUES: ApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];

function toApprovalStatus(value: unknown): ApprovalStatus {
  return APPROVAL_VALUES.includes(value as ApprovalStatus)
    ? (value as ApprovalStatus)
    : 'PENDING';
}

function leaveTypeName(lv: LeaveRequest['leaveType']): string {
  if (typeof lv === 'string') return lv;
  return lv?.name || lv?.code || 'Leave';
}

/**
 * Typed adapter: maps the dashboard's server-shaped LeaveRequest to the
 * canonical LeaveRequest consumed by LeaveApprovalModal without discarding
 * fields required for approval decisions or display.
 */
export function toModalLeave(leave: LeaveRequest): CanonicalLeaveRequest {
  return {
    id: leave.id,
    employee: {
      name: leave.employee?.user?.name || 'Unknown Employee',
      email: leave.employee?.user?.email || '',
    },
    leaveType: { name: leaveTypeName(leave.leaveType) },
    totalDays: leave.totalDays,
    startDate: leave.startDate,
    endDate: leave.endDate,
    reason: leave.reason ?? null,
    emergencyContact: leave.emergencyContact ?? null,
    backupEmployee: leave.backupEmployee?.user?.name
      ? { id: leave.backupEmployee.id, name: leave.backupEmployee.user.name }
      : null,
    managerApproval: toApprovalStatus(leave.managerApproval),
    hrApproval: toApprovalStatus(leave.hrApproval),
    status: toApprovalStatus(leave.status),
  };
}

/**
 * Normalizes the controller envelope `{ status: 'success', leaves: [...] }`
 * into a plain array. Falls back defensively to `data` only when the server
 * shape uses it, so a malformed payload yields an empty list rather than a
 * runtime crash.
 */
export function extractLeaves(responseData: unknown): LeaveRequest[] {
  const payload = responseData as
    | { leaves?: unknown; data?: unknown }
    | null
    | undefined;
  const candidate = Array.isArray(payload?.leaves)
    ? payload?.leaves
    : Array.isArray(payload?.data)
      ? payload?.data
      : [];
  return candidate.filter(
    (item): item is LeaveRequest =>
      !!item && typeof (item as LeaveRequest).id === 'string'
  );
}

type DecisionAction = 'approve' | 'reject';

const LeaveManagement = () => {
  const { user } = useAuth();

  // ✅ ALL HOOKS AT TOP LEVEL - NO CONDITIONAL HOOKS
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [selectedLeave, setSelectedLeave] = useState<LeaveRequest | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('all');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ✅ Calculate stats and filtered data with useMemo (not useState)
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

  const modalLeave = useMemo(
    () => (selectedLeave ? toModalLeave(selectedLeave) : null),
    [selectedLeave]
  );

  // Fetch leave data
  const loadLeaveData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const response = await apiService.request({
        method: 'GET',
        url: `${API_ENDPOINTS.hr.leaveRequests.list}?limit=${PAGE_LIMIT}`
      });

      if (!response.success) {
        throw new Error(response.message || 'Failed to load leave requests');
      }
      setLeaveRequests(extractLeaves(response.data));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Failed to load leave requests'
      );
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

  const canApproveAsManager = (leave: LeaveRequest) => {
    if (!user) return false;
    // Manager stage only: HR cannot act here, and the assigned manager must
    // not approve their own request.
    return (
      user.role !== 'hr_manager' &&
      user.role !== 'hr_staff' &&
      leave.managerApproval === 'PENDING' &&
      leave.hrApproval === 'PENDING' &&
      !!leave.managerId &&
      leave.managerId === user.id &&
      leave.employeeId !== user.id
    );
  };

  const canApproveAsHr = (leave: LeaveRequest) => {
    if (!user) return false;
    // HR stage is gated behind a successful manager approval.
    return (
      (user.role === 'hr_manager' || user.role === 'hr_staff') &&
      leave.managerApproval === 'APPROVED' &&
      leave.hrApproval === 'PENDING'
    );
  };

  const openApprovalModal = (leave: LeaveRequest) => {
    if (isSubmitting) return;
    setSelectedLeave(leave);
    setShowApprovalModal(true);
  };

  const closeApprovalModal = useCallback(() => {
    if (isSubmitting) return;
    setShowApprovalModal(false);
    setSelectedLeave(null);
  }, [isSubmitting]);

  /**
   * Shared approve/reject workflow. Uses the canonical endpoint map
   * (API_ENDPOINTS.hr.leaveRequests.approve.manager/hr) and the server's
   * { status, comments } payload contract, preserving the manager-first /
   * HR-second lifecycle enforced by the backend.
   */
  const handleDecision = useCallback(
    async (leaveId: string, comments: string, action: DecisionAction) => {
      if (isSubmitting) return;
      // Guard: the modal must be operating on the currently selected record.
      if (!selectedLeave || selectedLeave.id !== leaveId) {
        toast.error('The selected leave request changed. Please retry.');
        return;
      }

      const decidedStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
      const isHrStage = canApproveAsHr(selectedLeave);
      const url = isHrStage
        ? API_ENDPOINTS.hr.leaveRequests.approve.hr(leaveId)
        : API_ENDPOINTS.hr.leaveRequests.approve.manager(leaveId);

      setIsSubmitting(true);
      try {
        const response = await apiService.request({
          method: 'PATCH',
          url,
          data: { status: decidedStatus, comments },
        });

        if (!response.success) {
          // Surface the API error and keep the modal open — do not pretend
          // the decision was persisted.
          const serverMessage =
            (response.data as { error?: string } | null)?.error ||
            response.message ||
            'Failed to process leave decision';
          toast.error(serverMessage);
          return;
        }

        toast.success(
          action === 'approve'
            ? 'Leave request approved successfully'
            : 'Leave request rejected'
        );
        setShowApprovalModal(false);
        setSelectedLeave(null);
        // Refresh the persisted list and derived counts.
        await loadLeaveData();
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : 'Failed to process leave decision'
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, selectedLeave, loadLeaveData]
  );

  const handleApproveFromModal = useCallback(
    (leaveId: string, comments: string) => {
      void handleDecision(leaveId, comments, 'approve');
    },
    [handleDecision]
  );

  const handleRejectFromModal = useCallback(
    (leaveId: string, comments: string) => {
      void handleDecision(leaveId, comments, 'reject');
    },
    [handleDecision]
  );

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-6">
        <Card className="max-w-md mx-auto mt-16">
          <CardHeader>
            <CardTitle>Unable to load leave requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Button onClick={() => void loadLeaveData()}>Retry</Button>
          </CardContent>
        </Card>
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
                          <Badge variant="outline">{leaveTypeName(leave.leaveType)}</Badge>
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
                          <div className="mt-1">{getStatusBadge(leave.status)}</div>
                        </div>

                        {(canApproveAsManager(leave) || canApproveAsHr(leave)) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isSubmitting}
                            onClick={() => openApprovalModal(leave)}
                          >
                            Review &amp; Decide
                          </Button>
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

      {/* Canonical approval modal — single typed path from list row to decision */}
      <LeaveApprovalModal
        leave={modalLeave}
        isOpen={showApprovalModal && modalLeave !== null}
        onClose={closeApprovalModal}
        onApprove={handleApproveFromModal}
        onReject={handleRejectFromModal}
        isLoading={isSubmitting}
        userRole={
          user && (user.role === 'hr_manager' || user.role === 'hr_staff')
            ? 'hr'
            : 'manager'
        }
      />
    </div>
  );
};

export default LeaveManagement;
