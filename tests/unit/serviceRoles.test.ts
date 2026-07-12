import { describe, expect, it } from "vitest";
import {
  expectedServicesForRole,
  inappropriateServicesForRole,
  requireExpectedServicesForRole,
  serviceUnitsForSelection,
  SERVICE_UNITS,
} from "../../src/lib/operations/serviceRoles";

describe("serviceRoles", () => {
  describe("expectedServicesForRole - never defaults for an unknown role", () => {
    it("returns the correct services for each known role", () => {
      expect(expectedServicesForRole("camera-node")).toEqual(["agent"]);
      expect(expectedServicesForRole("coordinator")).toEqual(["web"]);
      expect(expectedServicesForRole("standalone")).toEqual(["web", "camera"]);
    });

    it("returns an empty array for null, undefined, an unknown string - never a default set", () => {
      expect(expectedServicesForRole(null)).toEqual([]);
      expect(expectedServicesForRole(undefined)).toEqual([]);
      expect(expectedServicesForRole("not-a-real-role")).toEqual([]);
      expect(expectedServicesForRole("")).toEqual([]);
    });
  });

  describe("requireExpectedServicesForRole - throws instead of guessing for mutating commands", () => {
    it("returns the same values as expectedServicesForRole for a known role", () => {
      expect(requireExpectedServicesForRole("camera-node")).toEqual(["agent"]);
    });

    it("throws for an unknown/missing role rather than returning a default", () => {
      expect(() => requireExpectedServicesForRole(null)).toThrow(/no role is configured/i);
      expect(() => requireExpectedServicesForRole("bogus-role")).toThrow(/unknown role/i);
    });
  });

  describe("inappropriateServicesForRole", () => {
    it("is the complement of expectedServicesForRole for a known role", () => {
      expect(inappropriateServicesForRole("camera-node").sort()).toEqual(["camera", "web"]);
      expect(inappropriateServicesForRole("coordinator").sort()).toEqual(["agent", "camera"]);
    });

    it("returns every service as inappropriate for an unknown role (nothing is 'expected')", () => {
      expect(inappropriateServicesForRole(null).sort()).toEqual(["agent", "camera", "web"]);
    });
  });

  describe("serviceUnitsForSelection", () => {
    it("an explicit --service selection never needs a role at all", () => {
      expect(serviceUnitsForSelection({ service: "web" })).toEqual([SERVICE_UNITS.web]);
      expect(serviceUnitsForSelection({ role: null, service: "agent" })).toEqual([SERVICE_UNITS.agent]);
    });

    it("--all never needs a role at all", () => {
      expect(serviceUnitsForSelection({ all: true })).toEqual([SERVICE_UNITS.web, SERVICE_UNITS.camera, SERVICE_UNITS.agent]);
      expect(serviceUnitsForSelection({ role: null, all: true })).toEqual([SERVICE_UNITS.web, SERVICE_UNITS.camera, SERVICE_UNITS.agent]);
    });

    it("throws for an unknown role when neither --service nor --all is given - this is what protects `service start` from guessing", () => {
      expect(() => serviceUnitsForSelection({ role: null })).toThrow();
      expect(() => serviceUnitsForSelection({ role: "not-a-role" })).toThrow();
    });

    it("resolves normally for a known role with neither --service nor --all", () => {
      expect(serviceUnitsForSelection({ role: "standalone" })).toEqual([SERVICE_UNITS.web, SERVICE_UNITS.camera]);
    });

    it("rejects an unknown --service value", () => {
      expect(() => serviceUnitsForSelection({ service: "not-a-service" })).toThrow(/unknown service/i);
    });
  });
});
