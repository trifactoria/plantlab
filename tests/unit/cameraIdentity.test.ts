import { describe, expect, it } from "vitest";
import { composeStableId, duplicatedSerialKeys, legacyStableId, normalizeUsbPhysicalPath, usbPathSuffix, type UsbIdentity } from "../../src/lib/cameraIdentity";

function identity(partial: Partial<UsbIdentity>): UsbIdentity {
  return {
    vendorId: null,
    productId: null,
    serial: null,
    physicalPath: null,
    usbPath: null,
    idPathTag: null,
    devpath: null,
    busInfo: null,
    ...partial,
  };
}

describe("camera physical identity", () => {
  it("normalizes udev ID_PATH by dropping the USB interface suffix", () => {
    const path = "platform-20980000.usb-usb-0:1.3:1.0";

    expect(normalizeUsbPhysicalPath(path)).toBe("platform-20980000.usb-usb-0:1.3");
    expect(usbPathSuffix(path)).toBe("1.3");
  });

  it("keeps a unique real serial as the stable identity and retains the legacy form", () => {
    const item = identity({ vendorId: "32e6", productId: "9221", serial: "REAL1", physicalPath: "platform-20980000.usb-usb-0:1.3" });

    expect(duplicatedSerialKeys([item])).toEqual(new Set());
    expect(composeStableId(item)).toBe("usb:32e6:9221:REAL1");
    expect(legacyStableId(item)).toBe("usb:32e6:9221:REAL1");
  });

  it("disambiguates duplicate serials with normalized physical USB paths", () => {
    const cameraA = identity({
      vendorId: "32e6",
      productId: "9221",
      serial: "202601081445001",
      physicalPath: "platform-20980000.usb-usb-0:1.3",
    });
    const cameraB = identity({
      vendorId: "32e6",
      productId: "9221",
      serial: "202601081445001",
      physicalPath: "platform-20980000.usb-usb-0:1.2",
    });
    const duplicateKeys = duplicatedSerialKeys([cameraA, cameraB]);

    expect(duplicateKeys).toEqual(new Set(["32e6:9221:202601081445001"]));
    expect(composeStableId(cameraA, { duplicateSerial: true })).toBe("usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.3");
    expect(composeStableId(cameraB, { duplicateSerial: true })).toBe("usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.2");
  });

  it("uses vendor, product, and physical path when serial is missing", () => {
    const item = identity({ vendorId: "32e6", productId: "9221", serial: null, physicalPath: "platform-20980000.usb-usb-0:1.3" });

    expect(composeStableId(item)).toBe("usb:32e6:9221:noserial:path:platform-20980000.usb-usb-0:1.3");
  });

  it("preserves enough USB hub path to distinguish identical cameras on different downstream ports", () => {
    const hubPath = "pci-0000:00:14.0-usb-0:4.2.3:1.0";

    expect(normalizeUsbPhysicalPath(hubPath)).toBe("pci-0000:00:14.0-usb-0:4.2.3");
    expect(usbPathSuffix(hubPath)).toBe("4.2.3");
  });
});
