import type { Color } from "@cornerstonejs/core/types";
import type {
    APP_CONSTANTS_TYPE,
    cornerstoneCustomColorLUTType, MiscColorMapType,
    OrganSystemsType,
    SegmentationCategories,
    SubSystems,
    Systems
} from "../types";

const configuredApiBase = String(import.meta.env.VITE_API_BASE || "").trim();
const hasWindow = typeof window !== "undefined";
const browserHost = hasWindow ? window.location.hostname : "";
const isBrowserLocalhost = browserHost === "localhost" || browserHost === "127.0.0.1";
const apiBaseLooksLocalhost = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(configuredApiBase);

export const API_BASE = configuredApiBase
	? (apiBaseLooksLocalhost && !isBrowserLocalhost ? "" : configuredApiBase.replace(/\/$/, ""))
	: "";
// export const API_BASE = "http://localhost:5001";

// old
// const x = {
//   1:  [229, 68, 68, 128],
//   2:  [229, 117, 68, 128],
//   3:  [229, 165, 68, 128],
//   5:  [229, 213, 68, 128],
//   6:  [197, 229, 68, 128],
//   7:  [149, 229, 68, 128],
//   8:  [100, 229, 68, 128],
//   11: [68, 229, 84, 128],
//   12: [65, 105, 225, 255], // Kidney (royal blue)
//   13: [30, 144, 255, 255], // Kidney (dodger blue)
//   14: [68, 229, 229, 128],
//   15: [173, 216, 230, 255], // Lung (light blue)
//   16: [135, 206, 235, 255], // Lung (sky blue)
//   17: [68, 84, 229, 128],
//   18: [100, 68, 229, 128],
//   19: [149, 68, 229, 128],
//   20: [197, 68, 229, 128],
//   21: [229, 68, 213, 128],
//   23: [229, 68, 165, 128],
//   25: [229, 68, 117, 128],
//   26: [229, 117, 68, 128],
//   27: [229, 68, 68, 128],
//   28: [229, 213, 68, 128]
//55

export const segmentation_category_colors: { [key: number]: Color } = {
	1: [255, 140, 0, 254], // Dark orange
	2: [255, 165, 0, 254], // Orange
	3: [255, 0, 0, 254], // Artery (red)
	4: [0, 191, 255, 254], // Urinary system (sky blue)
	5: [220, 20, 60, 254], // Artery (crimson red)
	6: [255, 160, 255, 254], // Digestive (salmon)
	7: [34, 139, 34, 254], // Green (bile duct)
	8: [255, 127, 80, 254], // Coral (GI tract)
	9: [245, 245, 245, 254], // Bone (light gray)
	10: [220, 220, 220, 254], // Bone (gray)
	11: [0, 128, 0, 254], // Dark green
	12: [68, 229, 133, 254],
	13: [68, 229, 181, 254],
	14: [178, 34, 34, 254], // Liver (brownish red)
	15: [68, 181, 229, 254],
	16: [68, 133, 229, 254],
	17: [255, 182, 193, 254], // Pancreas (light pink)
	18: [255, 105, 180, 254], // Pancreas (hot pink)
	19: [219, 112, 147, 254], // Pancreas (pale violet red)
	20: [255, 160, 122, 254], // Pancreas general (salmon)
	21: [255, 228, 181, 254], // Light tan (duct)
	22: [240, 10, 10, 254], // Pancreatic lesion (bright red)
	23: [72, 61, 139, 254], // Vein (dark slate blue)
	24: [255, 105, 180, 254], // Magenta/pink
	25: [138, 43, 226, 254], // Purple
	26: [255, 99, 71, 254], // Tomato red
	27: [255, 69, 0, 254], // Bright red-orange artery
	28: [106, 90, 205, 254], // Medium slate blue
	29: [255, 200, 120, 254], // Intestine (warm yellow-orange)
	30: [100, 149, 237, 254], // Renal vein left (cornflower blue)
	31: [70, 130, 180, 254],  // Renal vein right (steel blue)
	32: [192, 192, 192, 254], // CBD stent (silver-gray)
	33: [255, 140, 0, 254],   // Liver lesion (dark orange)
	34: [255, 215, 0, 254],   // Kidney lesion (gold)
	35: [220, 20, 60, 254],   // Colon lesion (crimson)
};

// Rotating palette of colours to hand out to new classes.
// No colour clash with existing organ palette above.
// Kept seperate from segmentation_category_colors, as these are assigned dynamically, not per-organ.
export const NEW_CLASS_PALETTE: Color[] = [
	[255, 99, 132, 255],  // pink
	[54, 162, 235, 255],  // blue
	[255, 206, 86, 255],  // yellow
	[75, 192, 192, 255],  // teal
	[153, 102, 255, 255], // purple
	[255, 159, 64, 255],  // orange
	[46, 204, 113, 255],  // green
	[231, 76, 60, 255],   // red
  ];

export const segmentation_categories: SegmentationCategories[] = [
	"adrenal_gland_left",
	"adrenal_gland_right",
	"aorta",
	"bladder",
	"celiac_artery",
	"colon",
	"common_bile_duct",
	"duodenum",
	"femur_left",
	"femur_right",
	"gall_bladder",
	"kidney_left",
	"kidney_right",
	"liver",
	"lung_left",
	"lung_right",
	"pancreas",
	"pancreas_body",
	"pancreas_head",
	"pancreas_tail",
	"pancreatic_duct",
	"postcava",
	"prostate",
	"spleen",
	"stomach",
	"superior_mesenteric_artery",
	"veins",
	"pancreatic_lesion",
	"intestine",
	"renal_vein_left",
	"renal_vein_right",
	"cbd_stent",
	"liver_lesion",
	"kidney_lesion",
	"colon_lesion",
];

export const OrganSystemsArray: Systems[] = [
	"Vascular System",
	"Digestive System",
	"Endocrine System",
	"Urinary System",
	"Skeletal System",
	"Lymphatic System",
	"Reproductive System",
	"Respiratory System"
	// "Adrenal Glands",
	// "Pancreas",
	// "Kidneys",
	// "Femur",
	// "Lung",
	// "Other"
];

export const OrgansSubsystemsArray: SubSystems[] = [
	"Kidneys",
	"Pancreas",
	"Colon"
]

export const MiscColorMap: MiscColorMapType = {
	"Kidneys": [144, 238, 200],
	"Pancreas": [244, 160, 160],
	"Colon": [238, 130, 238]
}

export const OrganSystems: OrganSystemsType = {
	"Vascular System": [
		"aorta",
		"celiac_artery",
		"superior_mesenteric_artery",
		"postcava",
		"veins",
		"renal_vein_left",
		"renal_vein_right",
	],
	"Endocrine System": ["adrenal_gland_left", "adrenal_gland_right"],
	"Urinary System": [{ Kidneys: ["kidney_left", "kidney_right", "kidney_lesion"] }, "bladder"],
	// bladder
	"Skeletal System": ["femur_left", "femur_right"],

	"Digestive System": [
		{
			Pancreas: [
				"pancreas",
				"pancreas_body",
				"pancreas_head",
				"pancreas_tail",
				"pancreatic_duct",
				"pancreatic_lesion",
			],
		},
		{ Colon: ["colon", "colon_lesion"] },
		"duodenum",
		"intestine",
		"stomach",
		"liver",
		"liver_lesion",
		"common_bile_duct",
		"gall_bladder",
		"cbd_stent",
	],
	"Respiratory System": ["lung_left", "lung_right"],
	"Reproductive System": ["prostate"],
	"Lymphatic System": ["spleen"],
};

const RED = [230, 25, 75, 255];
const BLUE = [0, 130, 200, 255];
const MAROON = [128, 0, 0, 255];
const BROWN = [170, 110, 40, 255];
const OLIVE = [128, 128, 0, 255];
//const OLIVE = [0, 0, 0, 0];
const TEAL = [0, 128, 128, 255];
const PURPLE = [145, 30, 180, 255];
const MAGENTA = [240, 50, 230, 255];
const LIME = [50, 205, 50, 255];

const cornerstoneCustomColorLUT: cornerstoneCustomColorLUTType = {
	0: [0, 0, 0, 0], // transparent for background
	1: RED,
	2: BLUE,
	3: MAROON,
	4: BROWN,
	5: OLIVE,
	6: TEAL,
	7: PURPLE,
	8: MAGENTA,
	9: LIME,
	// Add more mappings as needed
};
const NVCmapAlpha = 128;

function createNVColorMapFromCornerstoneLUT() {
	const R: number[] = [];
	const G: number[] = [];
	const B: number[] = [];
	const A: number[] = [];
	const I: number[] = [];
	Object.keys(cornerstoneCustomColorLUT).forEach((intensity) => {
		I.push(Number(intensity));
		const RGBA = cornerstoneCustomColorLUT[Number(intensity)];
		R.push(RGBA[0]);
		G.push(RGBA[1]);
		B.push(RGBA[2]);
		if (intensity === "0") {
			A.push(0);
		} else {
			A.push(NVCmapAlpha);
		}
	});

	const cmap = {
		R: R,
		G: G,
		B: B,
		A: A,
		I: I,
	};
	return cmap;
}

export const APP_CONSTANTS: APP_CONSTANTS_TYPE = {
	DEFAULT_SEGMENTATION_OPACITY: 0.6,
	API_ORIGIN: API_BASE,
	cornerstoneCustomColorLUT: cornerstoneCustomColorLUT,
	NVCmapAlpha: NVCmapAlpha,
	NVColormap: createNVColorMapFromCornerstoneLUT(),
};

export const ITEMS_PER_DATA_PAGE = 50;
