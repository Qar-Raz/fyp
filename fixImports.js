const fs = require('fs');

const path = '/home/muddasir/Project/fyp/app/(dashboard)/dashboard/users/[id]/data/user-data-client.tsx';
let data = fs.readFileSync(path, 'utf8');

// Replace static heavy component imports with dynamic
data = data.replace(
  /import \{\n\s*Sheet,\n\s*SheetContent,\n\s*SheetDescription,\n\s*SheetHeader,\n\s*SheetTitle,\n\} from "@\/components\/ui\/sheet"/g,
  `const Sheet = dynamic(() => import("@/components/ui/sheet").then(mod => mod.Sheet), { ssr: false });
const SheetContent = dynamic(() => import("@/components/ui/sheet").then(mod => mod.SheetContent), { ssr: false });
const SheetDescription = dynamic(() => import("@/components/ui/sheet").then(mod => mod.SheetDescription), { ssr: false });
const SheetHeader = dynamic(() => import("@/components/ui/sheet").then(mod => mod.SheetHeader), { ssr: false });
const SheetTitle = dynamic(() => import("@/components/ui/sheet").then(mod => mod.SheetTitle), { ssr: false });`
);

data = data.replace(
  /import \{\n\s*AlertDialog,\n\s*AlertDialogAction,\n\s*AlertDialogCancel,\n\s*AlertDialogContent,\n\s*AlertDialogDescription,\n\s*AlertDialogFooter,\n\s*AlertDialogHeader,\n\s*AlertDialogTitle,\n\} from "@\/components\/ui\/alert-dialog"/g,
  `const AlertDialog = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialog), { ssr: false });
const AlertDialogAction = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialogAction), { ssr: false });
const AlertDialogCancel = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialogCancel), { ssr: false });
const AlertDialogContent = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialogContent), { ssr: false });
const AlertDialogDescription = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialogDescription), { ssr: false });
const AlertDialogFooter = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialogFooter), { ssr: false });
const AlertDialogHeader = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialogHeader), { ssr: false });
const AlertDialogTitle = dynamic(() => import("@/components/ui/alert-dialog").then(mod => mod.AlertDialogTitle), { ssr: false });`
);

data = data.replace(
  /import \{\n\s*Dialog,\n\s*DialogContent,\n\s*DialogDescription,\n\s*DialogFooter,\n\s*DialogHeader,\n\s*DialogTitle,\n\} from "@\/components\/ui\/dialog"/g,
  `const Dialog = dynamic(() => import("@/components/ui/dialog").then(mod => mod.Dialog), { ssr: false });
const DialogContent = dynamic(() => import("@/components/ui/dialog").then(mod => mod.DialogContent), { ssr: false });
const DialogDescription = dynamic(() => import("@/components/ui/dialog").then(mod => mod.DialogDescription), { ssr: false });
const DialogFooter = dynamic(() => import("@/components/ui/dialog").then(mod => mod.DialogFooter), { ssr: false });
const DialogHeader = dynamic(() => import("@/components/ui/dialog").then(mod => mod.DialogHeader), { ssr: false });
const DialogTitle = dynamic(() => import("@/components/ui/dialog").then(mod => mod.DialogTitle), { ssr: false });`
);

fs.writeFileSync(path, data);
