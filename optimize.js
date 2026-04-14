const fs = require('fs');
const path = '/home/muddasir/Project/fyp/app/(dashboard)/dashboard/users/[id]/data/user-data-client.tsx';
let data = fs.readFileSync(path, 'utf8');

// The issue might be that React Markdown is huge or dnd-kit can be loaded dynamically, 
// wait, dnd-kit uses hooks so it has to be imported statically, or we dynamic import the WHOLE sorting component wrapper.
// To improve Time to First Paint (TTFP), let's defer loading the Upload Form (and its DnD dependencies)
// or defer loading the Dialog and Sheet components until they are actually opened. 
// "next/dynamic" on big components.

data = data.replace(
`import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet"`,
`import dynamic from "next/dynamic"\nimport {\n    Sheet,\n    SheetContent,\n    SheetDescription,\n    SheetHeader,\n    SheetTitle,\n} from "@/components/ui/sheet"`
);

// Actually, next/dynamic can only be used on components.

