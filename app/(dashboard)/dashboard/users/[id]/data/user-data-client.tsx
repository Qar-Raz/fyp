"use client"

import { useState, useActionState } from "react"
import Link from "next/link"
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import {
    FileText,
    X,
    Loader2,
    UploadCloud,
    GripVertical,
    Image as ImageIcon,
    ChevronLeft,
    ChevronRight,
    ArrowLeft,
    RefreshCw,
    Layers,
    ClipboardList,
    MessageSquare,
    ExternalLink,
    Trash2,
} from "lucide-react"
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core'
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { uploadUserDocument, getMedicalReportDetails, getDocumentDetails, getUserDocuments, deleteDocument, deleteAllDocuments, PatientDataType, UploadUserDocumentResult } from "../../data/actions"

interface UserDocument {
    id: string
    title: string
    type: string
    patientDataType: 'REPORT' | 'COMMENT' | null
    createdAt: string
    content: string
    isIngested: boolean
}

interface DocumentDetails {
    parentChunks: number
    childChunks: number
    files: Array<{ name: string; type: string }>
}

interface MedicalReportDetails {
    id: string
    documentId: string
    hospitalName: string | null
    reportDate: string | null
    reportURL: string | null
    createdAt: string
    markdown: string | null
    passed: boolean | null
    fidelityScore: number | null
    conclusion: string | null
    values: Array<{
        id: string
        key: string
        value: string
        unit: string | null
    }>
}

interface FileItem {
    id: string
    file: File
    progress: number
    base64?: string
    fileType: 'pdf' | 'image'
}

interface UserDataClientProps {
    userId: string
    userName: string
    initialDocuments: UserDocument[]
    initialTotalPages: number
}

interface FormState {
    error: string | null
    success: string | null
}

function SortableFileItem({
    item,
    onRemove,
    isPending
}: {
    item: FileItem
    onRemove: (id: string) => void
    isPending: boolean
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: item.id })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-600 ${isDragging ? 'shadow-lg dark:shadow-slate-900/50' : ''}`}
        >
            <button
                type="button"
                {...attributes}
                {...listeners}
                className="cursor-grab active:cursor-grabbing text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                disabled={isPending}
            >
                <GripVertical size={20} />
            </button>
            {item.fileType === 'pdf' ? (
                <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
            ) : (
                <ImageIcon className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-800 dark:text-slate-100 truncate text-sm">
                    {item.file.name}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    {(item.file.size / 1024 / 1024).toFixed(2)} MB • {item.fileType.toUpperCase()}
                </p>
            </div>
            {item.progress < 100 && (
                <div className="w-16">
                    <Progress value={item.progress} className="h-1.5 dark:bg-slate-700" />
                </div>
            )}
            <button
                type="button"
                onClick={() => onRemove(item.id)}
                className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 p-1 rounded-full hover:bg-red-50 dark:hover:bg-red-500/20 transition-colors"
                disabled={isPending}
            >
                <X size={16} />
            </button>
        </div>
    )
}

export default function UserDataClient({ userId, userName, initialDocuments, initialTotalPages }: UserDataClientProps) {
    const [files, setFiles] = useState<FileItem[]>([])
    const [dataType, setDataType] = useState<PatientDataType>("COMMENT")
    const [userDocuments, setUserDocuments] = useState<UserDocument[]>(initialDocuments)
    const [isLoadingDocs, setIsLoadingDocs] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const [totalPages, setTotalPages] = useState(initialTotalPages)
    const [isDeleteAllDialogOpen, setIsDeleteAllDialogOpen] = useState(false)
    const [deleteAllConfirmationText, setDeleteAllConfirmationText] = useState("")
    const [isDeletingAll, setIsDeletingAll] = useState(false)
    const [showUploadForm, setShowUploadForm] = useState(false)
    const [selectedDocument, setSelectedDocument] = useState<UserDocument | null>(null)
    const [documentDetails, setDocumentDetails] = useState<DocumentDetails | null>(null)
    const [medicalReportDetails, setMedicalReportDetails] = useState<MedicalReportDetails | null>(null)
    const [isLoadingDetails, setIsLoadingDetails] = useState(false)
    const [reportViewMode, setReportViewMode] = useState<"keyvalue" | "markdown">("keyvalue")
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
    const [documentToDelete, setDocumentToDelete] = useState<UserDocument | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    const fetchUserDocuments = async (page: number = 1) => {
        setIsLoadingDocs(true)
        try {
            const result = await getUserDocuments(userId, page)
            setUserDocuments(result.documents.map(doc => ({
                ...doc,
                createdAt: doc.createdAt.toISOString(),
            })))
            setTotalPages(result.totalPages)
        } catch (error) {
            console.error("Error fetching user documents:", error)
        } finally {
            setIsLoadingDocs(false)
        }
    }

    const fetchDocumentDetails = async (documentId: string) => {
        setIsLoadingDetails(true)
        setMedicalReportDetails(null)
        setDocumentDetails(null)
        setReportViewMode("keyvalue")

        const doc = userDocuments.find(d => d.id === documentId)
        setSelectedDocument(doc || null)

        try {
            if (doc?.patientDataType === 'REPORT') {
                const reportDetails = await getMedicalReportDetails(documentId)
                if (reportDetails) {
                    setMedicalReportDetails(reportDetails)
                }
            } else {
                const data = await getDocumentDetails(documentId)
                if (data) {
                    setDocumentDetails(data)
                }
            }
        } catch (error) {
            console.error("Error fetching document details:", error)
        } finally {
            setIsLoadingDetails(false)
        }
    }

    const handleDeleteClick = (e: React.MouseEvent, doc: UserDocument) => {
        e.stopPropagation() // Prevent triggering the document details sheet
        setDocumentToDelete(doc)
        setDeleteDialogOpen(true)
    }

    const handleDeleteConfirm = async () => {
        if (!documentToDelete) return

        setIsDeleting(true)
        try {
            const result = await deleteDocument(documentToDelete.id)
            if (result.success) {
                // Refresh the documents list
                await fetchUserDocuments(currentPage)
                // Close the sheet if the deleted document was selected
                if (selectedDocument?.id === documentToDelete.id) {
                    setSelectedDocument(null)
                    setDocumentDetails(null)
                    setMedicalReportDetails(null)
                }
            }
        } catch (error) {
            console.error("Error deleting document:", error)
        } finally {
            setIsDeleting(false)
            setDeleteDialogOpen(false)
            setDocumentToDelete(null)
        }
    }

    const handleDeleteAllConfirm = async () => {
        setIsDeletingAll(true)
        try {
            const result = await deleteAllDocuments(userId)
            if (result.success) {
                // Refresh the documents list
                await fetchUserDocuments(1)
                setCurrentPage(1)
                // Reset the selected document
                setSelectedDocument(null)
                setDocumentDetails(null)
                setMedicalReportDetails(null)
            }
        } catch (error) {
            console.error("Error deleting all documents:", error)
        } finally {
            setIsDeletingAll(false)
            setIsDeleteAllDialogOpen(false)
            setDeleteAllConfirmationText("")
        }
    }

    const fileToBase64 = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.readAsDataURL(file)
            reader.onload = () => {
                const result = reader.result as string
                const base64 = result.split(',')[1]
                resolve(base64)
            }
            reader.onerror = (error) => reject(error)
        })
    }

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []) as File[]
        const validFiles = files.filter(file => {
            const isPdf = file.type === 'application/pdf'
            const isImage = file.type.startsWith('image/')
            return isPdf || isImage
        })

        if (validFiles.length !== files.length) {
            console.warn("Some files were skipped. Only PDF and image files are allowed.")
        }

        const remainingSlots = 10 - files.length

        if (remainingSlots <= 0) {
            console.warn("Maximum of 5 files already reached.")
            return
        }

        const filesToAdd = validFiles.slice(0, remainingSlots)

        if (validFiles.length > remainingSlots) {
            console.warn(`Only the first ${remainingSlots} file(s) were added. Maximum is 5 files total.`)
        }

        const newFileItems: FileItem[] = filesToAdd.map((file) => ({
            id: `${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            file,
            progress: 0,
            fileType: file.type === 'application/pdf' ? 'pdf' : 'image',
        }))

        setFiles(prev => [...prev, ...newFileItems])

        for (const item of newFileItems) {
            let progress = 0
            const interval = setInterval(() => {
                progress += 10
                if (progress <= 90) {
                    setFiles(prev =>
                        prev.map(f => f.id === item.id ? { ...f, progress } : f)
                    )
                }
            }, 50)

            try {
                const base64 = await fileToBase64(item.file)
                clearInterval(interval)
                setFiles(prev =>
                    prev.map(f => f.id === item.id ? { ...f, progress: 100, base64 } : f)
                )
            } catch (error) {
                clearInterval(interval)
                console.error("Error converting file to base64:", error)
                setFiles(prev => prev.filter(f => f.id !== item.id))
            }
        }
    }

    const handleRemoveFile = (id: string) => {
        setFiles(prev => prev.filter(f => f.id !== id))
    }

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            setFiles((items) => {
                const oldIndex = items.findIndex(item => item.id === active.id)
                const newIndex = items.findIndex(item => item.id === over.id)
                return arrayMove(items, oldIndex, newIndex)
            })
        }
    }

    const uploadAction = async (_prevState: FormState, formData: FormData): Promise<FormState> => {
        if (files.length === 0) {
            return { error: "Please select at least one file.", success: null }
        }

        const title = formData.get("documentTitle") as string
        if (!title?.trim()) {
            return { error: "Please enter a document title.", success: null }
        }

        const allProcessed = files.every(f => f.base64 && f.progress === 100)
        if (!allProcessed) {
            return { error: "Please wait for all files to finish processing.", success: null }
        }

        formData.set("title", title.trim())
        formData.set("userId", userId)
        formData.set("dataType", dataType)

        const filesData = files.map(f => ({
            base64: f.base64!,
            type: f.fileType,
            name: f.file.name,
        }))
        formData.set("files", JSON.stringify(filesData))

        try {
            const result: UploadUserDocumentResult = await uploadUserDocument(formData)

            if (result.success) {
                setFiles([])
                setDataType("COMMENT")
                setShowUploadForm(false)
                fetchUserDocuments(1)
                setCurrentPage(1)
                return { error: null, success: result.message }
            } else {
                return { error: result.message, success: null }
            }
        } catch (error) {
            console.error("Error uploading document:", error)
            return { error: "An unexpected error occurred. Please try again.", success: null }
        }
    }

    const [formState, formAction, isPending] = useActionState<FormState, FormData>(uploadAction, {
        error: null,
        success: null,
    })

    const isLoading = isPending

    return (
        <>
            <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
                <div className="flex items-center gap-2 px-4">
                    <SidebarTrigger className="-ml-1" />
                    <Separator
                        orientation="vertical"
                        className="mr-2 data-[orientation=vertical]:h-4"
                    />
                    <Breadcrumb>
                        <BreadcrumbList>
                            <BreadcrumbItem className="hidden md:block">
                                <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator className="hidden md:block" />
                            <BreadcrumbItem>
                                <BreadcrumbLink href="/dashboard/users">User Management</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator className="hidden md:block" />
                            <BreadcrumbItem>
                                <BreadcrumbLink href="/dashboard/users/data">User Data</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator className="hidden md:block" />
                            <BreadcrumbItem>
                                <BreadcrumbPage>{userName || "User"}</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                </div>
            </header>

            <div className="flex flex-1 flex-col gap-6 p-6 pt-0">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">User Documents</h1>
                        <p className="text-muted-foreground mt-1">
                            Managing documents for {userName || "User"}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="destructive"
                            onClick={() => setIsDeleteAllDialogOpen(true)}
                        >
                            Delete All
                        </Button>
                        <Button variant="outline" onClick={() => fetchUserDocuments(currentPage)} disabled={isLoadingDocs}>
                            <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingDocs ? "animate-spin" : ""}`} />
                            Refresh
                        </Button>
                        <Button onClick={() => setShowUploadForm(!showUploadForm)}>
                            <UploadCloud className="h-4 w-4 mr-2" />
                            {showUploadForm ? "Cancel" : "Add Documents"}
                        </Button>
                    </div>
                </div>

                {/* Upload Form */}
                {showUploadForm && (
                    <div className="rounded-xl border bg-card shadow-sm p-6">
                        <h2 className="text-lg font-semibold mb-4">Upload New Documents</h2>
                        <form action={formAction} className="space-y-6">
                            {/* Data Type Selector */}
                            <div className="space-y-3">
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                                    Data Type
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setDataType("REPORT")}
                                        disabled={isLoading}
                                        className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-all ${dataType === "REPORT"
                                            ? "border-blue-500 bg-blue-50 dark:bg-blue-500/10 dark:border-blue-400"
                                            : "border-slate-200 dark:border-slate-600 hover:border-slate-300 dark:hover:border-slate-500"
                                            }`}
                                    >
                                        <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${dataType === "REPORT"
                                            ? "bg-blue-100 dark:bg-blue-500/20"
                                            : "bg-slate-100 dark:bg-slate-800"
                                            }`}>
                                            <ClipboardList className={`h-5 w-5 ${dataType === "REPORT"
                                                ? "text-blue-600 dark:text-blue-400"
                                                : "text-slate-500 dark:text-slate-400"
                                                }`} />
                                        </div>
                                        <div className="text-left">
                                            <p className={`font-medium ${dataType === "REPORT"
                                                ? "text-blue-700 dark:text-blue-300"
                                                : "text-slate-700 dark:text-slate-200"
                                                }`}>
                                                Medical Report
                                            </p>
                                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                                Extract key-value pairs (lab tests, vitals)
                                            </p>
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setDataType("COMMENT")}
                                        disabled={isLoading}
                                        className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-all ${dataType === "COMMENT"
                                            ? "border-green-500 bg-green-50 dark:bg-green-500/10 dark:border-green-400"
                                            : "border-slate-200 dark:border-slate-600 hover:border-slate-300 dark:hover:border-slate-500"
                                            }`}
                                    >
                                        <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${dataType === "COMMENT"
                                            ? "bg-green-100 dark:bg-green-500/20"
                                            : "bg-slate-100 dark:bg-slate-800"
                                            }`}>
                                            <MessageSquare className={`h-5 w-5 ${dataType === "COMMENT"
                                                ? "text-green-600 dark:text-green-400"
                                                : "text-slate-500 dark:text-slate-400"
                                                }`} />
                                        </div>
                                        <div className="text-left">
                                            <p className={`font-medium ${dataType === "COMMENT"
                                                ? "text-green-700 dark:text-green-300"
                                                : "text-slate-700 dark:text-slate-200"
                                                }`}>
                                                Comments / Notes
                                            </p>
                                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                                Semantic embedding for AI search
                                            </p>
                                        </div>
                                    </button>
                                </div>
                            </div>

                            {/* Document Title */}
                            <div className="space-y-2">
                                <label
                                    htmlFor="documentTitle"
                                    className="block text-sm font-medium text-slate-700 dark:text-slate-200"
                                >
                                    Document Title
                                </label>
                                <Input
                                    id="documentTitle"
                                    name="documentTitle"
                                    placeholder="Enter a descriptive title..."
                                    disabled={isLoading}
                                />
                            </div>

                            {/* File Upload */}
                            <div className="space-y-4">
                                <div className="flex justify-between items-center">
                                    <label
                                        htmlFor="fileInput"
                                        className="block text-sm font-medium text-slate-700 dark:text-slate-200"
                                    >
                                        Upload Files (PDF & Images, up to 5)
                                    </label>
                                    <span className="text-sm text-slate-500 dark:text-slate-400">
                                        {files.length}/5 files
                                    </span>
                                </div>

                                <input
                                    type="file"
                                    id="fileInput"
                                    name="fileInput"
                                    accept=".pdf,application/pdf,image/*"
                                    multiple={true}
                                    className="hidden"
                                    onChange={handleFileChange}
                                    disabled={isLoading || files.length >= 5}
                                />

                                {files.length < 5 && (
                                    <div className="border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg p-6 text-center hover:border-blue-500 dark:hover:border-blue-400 bg-slate-50/50 dark:bg-slate-800/30 transition-colors duration-200">
                                        <div className="space-y-3">
                                            <div className="mx-auto w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center">
                                                <UploadCloud className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                                            </div>
                                            <div>
                                                <p className="text-sm text-slate-700 dark:text-slate-300">
                                                    Drag and drop your files here, or
                                                </p>
                                                <label
                                                    htmlFor="fileInput"
                                                    className="mt-2 inline-block px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white text-sm rounded-lg cursor-pointer transition-colors duration-200"
                                                >
                                                    Browse files
                                                </label>
                                            </div>
                                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                                PDF and image files only, up to 10MB each • {5 - files.length} slot(s) remaining
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {files.length > 0 && (
                                    <div className="space-y-2">
                                        <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                                            <GripVertical size={14} className="text-slate-400 dark:text-slate-500" />
                                            Drag to reorder • Files will be processed in this order
                                        </p>
                                        <DndContext
                                            sensors={sensors}
                                            collisionDetection={closestCenter}
                                            onDragEnd={handleDragEnd}
                                        >
                                            <SortableContext
                                                items={files.map(f => f.id)}
                                                strategy={verticalListSortingStrategy}
                                            >
                                                <div className="space-y-2">
                                                    {files.map((item, index) => (
                                                        <div key={item.id} className="relative">
                                                            <span className="absolute -left-6 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400 dark:text-slate-500 tabular-nums">
                                                                {index + 1}
                                                            </span>
                                                            <SortableFileItem
                                                                item={item}
                                                                onRemove={handleRemoveFile}
                                                                isPending={isLoading}
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            </SortableContext>
                                        </DndContext>
                                    </div>
                                )}

                                {files.length >= 5 && (
                                    <p className="text-amber-600 dark:text-amber-400 text-sm flex items-center gap-1.5">
                                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400"></span>
                                        Maximum of 5 files reached
                                    </p>
                                )}
                            </div>

                            <div className="flex gap-3">
                                <Button
                                    type="submit"
                                    disabled={isLoading || files.length === 0}
                                    className="flex-1"
                                >
                                    {isLoading ? (
                                        <span className="flex items-center justify-center">
                                            <Loader2 className="animate-spin mr-2 h-5 w-5" />
                                            Processing...
                                        </span>
                                    ) : (
                                        "Upload Documents"
                                    )}
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        setShowUploadForm(false)
                                        setFiles([])
                                        setDataType("COMMENT")
                                    }}
                                    disabled={isLoading}
                                >
                                    Cancel
                                </Button>
                            </div>

                            {(formState.error || formState.success) && (
                                <div
                                    className={`p-4 rounded-lg border ${formState.error
                                        ? "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-800 dark:text-red-300"
                                        : "bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30 text-green-800 dark:text-green-300"
                                        } flex items-start`}
                                >
                                    <div className={`rounded-full w-6 h-6 mr-3 shrink-0 flex items-center justify-center text-sm font-bold ${formState.error
                                        ? "bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400"
                                        : "bg-green-100 dark:bg-green-500/20 text-green-600 dark:text-green-400"
                                        }`}>
                                        {formState.error ? "!" : "✓"}
                                    </div>
                                    <div>
                                        <p className="font-medium">{formState.error ? "Error" : "Success"}</p>
                                        <p className="text-sm opacity-90">{formState.error || formState.success}</p>
                                    </div>
                                </div>
                            )}
                        </form>
                    </div>
                )}

                {/* User Documents List */}
                <div className="rounded-xl border bg-card shadow-sm p-6">
                    <h2 className="text-lg font-semibold mb-4">Documents ({userDocuments.length})</h2>
                    {isLoadingDocs ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                    ) : userDocuments.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground">
                            <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                            <p>No documents found for this user</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {userDocuments.map((doc) => (
                                <div
                                    key={doc.id}
                                    onClick={() => fetchDocumentDetails(doc.id)}
                                    className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-600 cursor-pointer hover:border-primary/50 transition-colors"
                                >
                                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${doc.patientDataType === 'REPORT'
                                        ? "bg-blue-100 dark:bg-blue-500/20"
                                        : "bg-green-100 dark:bg-green-500/20"
                                        }`}>
                                        {doc.patientDataType === 'REPORT' ? (
                                            <ClipboardList className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                                        ) : (
                                            <MessageSquare className="h-5 w-5 text-green-600 dark:text-green-400" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium text-sm truncate">{doc.title}</p>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${doc.patientDataType === 'REPORT'
                                                ? "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"
                                                : "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                                                }`}>
                                                {doc.patientDataType === 'REPORT' ? 'Report' : 'Comment'}
                                            </span>
                                            <span>
                                                {new Date(doc.createdAt).toLocaleDateString("en-US", {
                                                    year: "numeric",
                                                    month: "short",
                                                    day: "numeric",
                                                })}
                                            </span>
                                            {doc.isIngested && (
                                                <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                                                    <Layers className="h-3 w-3" />
                                                    {doc.patientDataType === 'REPORT' ? 'Processed' : 'Embedded'}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={(e) => handleDeleteClick(e, doc)}
                                        className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 p-2 rounded-full hover:bg-red-50 dark:hover:bg-red-500/20 transition-colors"
                                        title="Delete document"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}

                            {totalPages > 1 && (
                                <div className="flex items-center justify-between pt-4">
                                    <p className="text-sm text-muted-foreground">
                                        Page {currentPage} of {totalPages}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                const newPage = Math.max(currentPage - 1, 1)
                                                setCurrentPage(newPage)
                                                fetchUserDocuments(newPage)
                                            }}
                                            disabled={currentPage === 1}
                                        >
                                            <ChevronLeft className="h-4 w-4" />
                                            Previous
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                const newPage = Math.min(currentPage + 1, totalPages)
                                                setCurrentPage(newPage)
                                                fetchUserDocuments(newPage)
                                            }}
                                            disabled={currentPage === totalPages}
                                        >
                                            Next
                                            <ChevronRight className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Document Details Sheet */}
                <Sheet open={selectedDocument !== null} onOpenChange={(open) => !open && setSelectedDocument(null)}>
                    <SheetContent side="right" className="w-full sm:max-w-2xl lg:max-w-3xl overflow-y-auto p-0">
                        <SheetHeader className="sticky top-0 z-10 bg-background border-b px-6 py-5">
                            <SheetTitle className="text-lg">
                                {selectedDocument?.patientDataType === 'REPORT' ? 'Medical Report' : 'Document Details'}
                            </SheetTitle>
                            <SheetDescription>
                                {selectedDocument?.title}
                            </SheetDescription>
                        </SheetHeader>

                        <div className="px-6 py-6">
                            {isLoadingDetails ? (
                                <div className="flex items-center justify-center py-20">
                                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                                </div>
                            ) : selectedDocument?.patientDataType === 'REPORT' && medicalReportDetails ? (
                                /* Medical Report Details View */
                                <div className="space-y-6">
                                    {/* Report Info Grid */}
                                    <div className="grid gap-3 grid-cols-2">
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Hospital / Lab</p>
                                            <p className="font-medium mt-1.5 text-sm">{medicalReportDetails.hospitalName ?? "Not detected"}</p>
                                        </div>
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Report Date</p>
                                            <p className="font-medium mt-1.5 text-sm">
                                                {medicalReportDetails.reportDate
                                                    ? new Date(medicalReportDetails.reportDate).toLocaleDateString("en-US", {
                                                        year: "numeric",
                                                        month: "long",
                                                        day: "numeric",
                                                    })
                                                    : "Not detected"}
                                            </p>
                                        </div>
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Uploaded</p>
                                            <p className="font-medium mt-1.5 text-sm">
                                                {selectedDocument ? new Date(selectedDocument.createdAt).toLocaleDateString("en-US", {
                                                    year: "numeric",
                                                    month: "short",
                                                    day: "numeric",
                                                }) : "-"}
                                            </p>
                                        </div>
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Test Values</p>
                                            <p className="font-medium mt-1.5 text-sm">{medicalReportDetails.values.length} extracted</p>
                                        </div>
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Fidelity Score</p>
                                            <div className="flex items-center gap-2 mt-1.5">
                                                {medicalReportDetails.fidelityScore !== null ? (
                                                    <>
                                                        <div className="flex-1">
                                                            <div className="flex items-center justify-between mb-1">
                                                                <span className={`text-sm font-medium ${medicalReportDetails.fidelityScore >= 0.8 ? "text-green-600 dark:text-green-400" :
                                                                    medicalReportDetails.fidelityScore >= 0.6 ? "text-yellow-600 dark:text-yellow-400" :
                                                                        medicalReportDetails.fidelityScore >= 0.4 ? "text-orange-600 dark:text-orange-400" :
                                                                            "text-red-600 dark:text-red-400"
                                                                    }`}>
                                                                    {(medicalReportDetails.fidelityScore * 100).toFixed(0)}%
                                                                </span>
                                                                {medicalReportDetails.passed !== null && (
                                                                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${medicalReportDetails.passed
                                                                        ? "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                                                                        : "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                                                                        }`}>
                                                                        {medicalReportDetails.passed ? "Passed" : "Failed"}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                                                                <div
                                                                    className={`h-full rounded-full transition-all ${medicalReportDetails.fidelityScore >= 0.8 ? "bg-green-500" :
                                                                        medicalReportDetails.fidelityScore >= 0.6 ? "bg-yellow-500" :
                                                                            medicalReportDetails.fidelityScore >= 0.4 ? "bg-orange-500" :
                                                                                "bg-red-500"
                                                                        }`}
                                                                    style={{ width: `${medicalReportDetails.fidelityScore * 100}%` }}
                                                                />
                                                            </div>
                                                        </div>
                                                    </>
                                                ) : (
                                                    <span className="text-sm text-muted-foreground">Not calculated</span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Validation</p>
                                            <p className="font-medium mt-1.5 text-sm">
                                                {medicalReportDetails.passed === true ? (
                                                    <span className="text-green-600 dark:text-green-400">All values verified</span>
                                                ) : medicalReportDetails.passed === false ? (
                                                    <span className="text-red-600 dark:text-red-400">Issues detected</span>
                                                ) : (
                                                    <span className="text-muted-foreground">Not validated</span>
                                                )}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Report File Link */}
                                    {medicalReportDetails.reportURL && (
                                        <a
                                            href={medicalReportDetails.reportURL}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-3 p-4 rounded-lg border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/30 hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors"
                                        >
                                            <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center shrink-0">
                                                <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="font-medium text-sm text-blue-700 dark:text-blue-300">View Original Report</p>
                                                <p className="text-xs text-blue-600/70 dark:text-blue-400/70 truncate">{medicalReportDetails.reportURL}</p>
                                            </div>
                                            <ExternalLink className="h-4 w-4 text-blue-500 dark:text-blue-400 shrink-0" />
                                        </a>
                                    )}

                                    {/* View Mode Toggle */}
                                    {medicalReportDetails.markdown && (
                                        <div className="flex items-center gap-2 bg-muted/50 rounded-lg p-1">
                                            <button
                                                type="button"
                                                onClick={() => setReportViewMode("keyvalue")}
                                                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-all text-center ${reportViewMode === "keyvalue"
                                                    ? "bg-background text-foreground shadow-sm"
                                                    : "text-muted-foreground hover:text-foreground"
                                                    }`}
                                            >
                                                Key-Value Pairs
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setReportViewMode("markdown")}
                                                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-all text-center ${reportViewMode === "markdown"
                                                    ? "bg-background text-foreground shadow-sm"
                                                    : "text-muted-foreground hover:text-foreground"
                                                    }`}
                                            >
                                                Raw Text
                                            </button>
                                        </div>
                                    )}

                                    {/* AI Conclusion */}
                                    {medicalReportDetails.conclusion && (
                                        <div className={`rounded-lg border p-4 ${medicalReportDetails.passed === true
                                            ? "bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30"
                                            : "bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/30"
                                            }`}>
                                            <div className="flex items-start gap-3">
                                                <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${medicalReportDetails.passed === true
                                                    ? "bg-green-100 dark:bg-green-500/20"
                                                    : "bg-orange-100 dark:bg-orange-500/20"
                                                    }`}>
                                                    {medicalReportDetails.passed === true ? (
                                                        <svg className="h-4 w-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                                        </svg>
                                                    ) : (
                                                        <svg className="h-4 w-4 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                                        </svg>
                                                    )}
                                                </div>
                                                <div className="flex-1">
                                                    <p className={`text-sm font-medium mb-1 ${medicalReportDetails.passed === true
                                                        ? "text-green-700 dark:text-green-300"
                                                        : "text-orange-700 dark:text-orange-300"
                                                        }`}>
                                                        {medicalReportDetails.passed === true ? "Validation Passed" : "Validation Issues Detected"}
                                                    </p>
                                                    <p className={`text-sm ${medicalReportDetails.passed === true
                                                        ? "text-green-600/80 dark:text-green-400/80"
                                                        : "text-orange-600/80 dark:text-orange-400/80"
                                                        }`}>
                                                        {medicalReportDetails.conclusion}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Content based on view mode */}
                                    {reportViewMode === "markdown" && medicalReportDetails.markdown ? (
                                        <div className="rounded-lg border bg-muted/30 p-4 overflow-x-auto">
                                            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed wrap-break-word">{medicalReportDetails.markdown}</pre>
                                        </div>
                                    ) : (
                                        <div>
                                            {medicalReportDetails.values.length > 0 ? (
                                                <div className="rounded-lg border overflow-hidden">
                                                    <table className="w-full text-sm">
                                                        <thead>
                                                            <tr className="border-b bg-muted/50">
                                                                <th className="text-left p-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">Test Name</th>
                                                                <th className="text-right p-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">Value</th>
                                                                <th className="text-left p-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">Unit</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y">
                                                            {medicalReportDetails.values.map((val) => (
                                                                <tr key={val.id} className="hover:bg-muted/30 transition-colors">
                                                                    <td className="p-3 font-medium">{val.key}</td>
                                                                    <td className="p-3 text-right tabular-nums font-mono">{val.value}</td>
                                                                    <td className="p-3 text-muted-foreground">{val.unit ?? "—"}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            ) : (
                                                <div className="text-center py-12 text-muted-foreground rounded-lg border bg-muted/30">
                                                    <ClipboardList className="h-10 w-10 mx-auto mb-3 opacity-40" />
                                                    <p className="font-medium">No test values extracted</p>
                                                    <p className="text-sm mt-1">The report may not contain recognized test formats.</p>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ) : documentDetails ? (
                                /* Comment/Embedding Details View */
                                <div className="space-y-6">
                                    <div className="grid gap-3 grid-cols-2">
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</p>
                                            <p className="font-medium mt-1.5 text-sm">{selectedDocument?.title ?? "-"}</p>
                                        </div>
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Created</p>
                                            <p className="font-medium mt-1.5 text-sm">
                                                {selectedDocument ? new Date(selectedDocument.createdAt).toLocaleDateString("en-US", {
                                                    year: "numeric",
                                                    month: "short",
                                                    day: "numeric",
                                                }) : "-"}
                                            </p>
                                        </div>
                                        <div className="p-4 rounded-lg border bg-muted/30">
                                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</p>
                                            <p className={`font-medium mt-1.5 text-sm ${selectedDocument?.isIngested ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
                                                {selectedDocument?.isIngested ? "Embedded" : "Processing"}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="space-y-3">
                                        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Chunk Statistics</h3>
                                        <div className="grid gap-3 grid-cols-2">
                                            <div className="flex items-center gap-3 p-4 rounded-lg border bg-muted/30">
                                                <div className="h-10 w-10 rounded-lg bg-purple-100 dark:bg-purple-500/20 flex items-center justify-center shrink-0">
                                                    <Layers className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                                                </div>
                                                <div>
                                                    <p className="text-xs text-muted-foreground">Parent Chunks</p>
                                                    <p className="text-xl font-bold">{documentDetails.parentChunks}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3 p-4 rounded-lg border bg-muted/30">
                                                <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center shrink-0">
                                                    <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                                                </div>
                                                <div>
                                                    <p className="text-xs text-muted-foreground">Child Chunks</p>
                                                    <p className="text-xl font-bold">{documentDetails.childChunks}</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-3">
                                        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Files</h3>
                                        <div className="space-y-2">
                                            {documentDetails.files.map((file, index) => (
                                                <div key={index} className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
                                                    {file.type === 'pdf' ? (
                                                        <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
                                                    ) : (
                                                        <ImageIcon className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
                                                    )}
                                                    <div className="flex-1 min-w-0">
                                                        <p className="font-medium text-sm truncate">{file.name}</p>
                                                        <p className="text-xs text-muted-foreground uppercase">{file.type}</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="text-center py-16 text-muted-foreground">
                                    <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
                                    <p>No details available for this document.</p>
                                </div>
                            )}
                        </div>
                    </SheetContent>
                </Sheet>

                {/* Back Button */}
                <div className="flex justify-center">
                    <Link href="/dashboard/users/data">
                        <Button variant="outline" className="gap-2">
                            <ArrowLeft className="h-4 w-4" />
                            Back to User Data
                        </Button>
                    </Link>
                </div>

                {/* Delete Confirmation Dialog */}
                <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Delete Document</AlertDialogTitle>
                            <AlertDialogDescription>
                                Are you sure you want to delete &ldquo;{documentToDelete?.title}&rdquo;? This action cannot be undone.
                                {documentToDelete?.patientDataType === 'REPORT' && (
                                    <span className="block mt-2 text-orange-600 dark:text-orange-400">
                                        This will also delete all associated medical report data and test values.
                                    </span>
                                )}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                                onClick={handleDeleteConfirm}
                                disabled={isDeleting}
                                className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            >
                                {isDeleting ? (
                                    <span className="flex items-center gap-2">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Deleting...
                                    </span>
                                ) : (
                                    "Delete"
                                )}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>

                {/* Delete All Documents Dialog */}
                <Dialog open={isDeleteAllDialogOpen} onOpenChange={setIsDeleteAllDialogOpen}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Delete All Documents</DialogTitle>
                            <DialogDescription>
                                Are you sure you want to delete ALL documents for {userName}? This action cannot be undone.
                                <span className="block mt-2 text-orange-600 dark:text-orange-400">
                                    This will also delete all associated medical report data, test values, and chunks.
                                </span>
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <label htmlFor="delete-all-confirmation" className="text-sm font-medium">
                                    Type <span className="font-mono bg-muted px-1.5 py-0.5 rounded">DELETE ALL</span> to confirm
                                </label>
                                <Input
                                    id="delete-all-confirmation"
                                    value={deleteAllConfirmationText}
                                    onChange={(e) => setDeleteAllConfirmationText(e.target.value)}
                                    placeholder="Type DELETE ALL to confirm"
                                    disabled={isDeletingAll}
                                />
                            </div>
                        </div>
                        <DialogFooter>
                            <Button
                                variant="outline"
                                onClick={() => setIsDeleteAllDialogOpen(false)}
                                disabled={isDeletingAll}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={handleDeleteAllConfirm}
                                disabled={isDeletingAll || deleteAllConfirmationText !== "DELETE ALL"}
                            >
                                {isDeletingAll ? (
                                    <span className="flex items-center gap-2">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Deleting...
                                    </span>
                                ) : (
                                    "Delete All Documents"
                                )}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </>
    )
}
