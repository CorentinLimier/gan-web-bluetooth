
import * as def from './gan-cube-definitions';
import { GanGen2CubeEncrypter, GanGen3CubeEncrypter, GanGen4CubeEncrypter } from './gan-cube-encrypter';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove,
    GanCubeClassicConnection,
    GanGen2ProtocolDriver,
    GanGen3ProtocolDriver,
    GanGen4ProtocolDriver
} from './gan-cube-protocol';

/** Iterate over all known GAN cube CICs to find Manufacturer Specific Data */
function getManufacturerDataBytes(manufacturerData: BluetoothManufacturerData | DataView): DataView | undefined {
    // Workaround for Bluefy browser which may return raw DataView directly instead of Map
    if (manufacturerData instanceof DataView) {
        return new DataView(manufacturerData.buffer.slice(2, 11));
    }
    for (var id of def.GAN_CIC_LIST) {
        if (manufacturerData.has(id)) {
            return new DataView(manufacturerData.get(id)!.buffer.slice(0, 9));
        }
    }
    return;
}

/** Extract MAC from last 6 bytes of Manufacturer Specific Data */
function extractMAC(manufacturerData: BluetoothManufacturerData): string {
    var mac: Array<string> = [];
    var dataView = getManufacturerDataBytes(manufacturerData);
    if (dataView && dataView.byteLength >= 6) {
        for (let i = 1; i <= 6; i++) {
            mac.push(dataView.getUint8(dataView.byteLength - i).toString(16).toUpperCase().padStart(2, "0"));
        }
    }
    return mac.join(":");
}

/** If browser supports Web Bluetooth watchAdvertisements() API, try to retrieve MAC address automatically */

async function autoRetrieveMacAddress(
    device: BluetoothDevice
): Promise<string | null> {

    const prefix = '[GAN-BLE]';

    console.log(prefix, 'MAC_AUTO_START', {
        deviceName: device.name,
        deviceId: device.id,
        watchAdvertisementsAvailable:
            typeof device.watchAdvertisements === 'function'
    });

    if (typeof device.watchAdvertisements !== 'function') {
        console.warn(prefix, 'MAC_WATCH_ADVERTISEMENTS_UNSUPPORTED');
        return null;
    }

    return new Promise<string | null>((resolve) => {
        const abortController = new AbortController();
        let finished = false;

        const finish = (mac: string | null, reason: string) => {
            if (finished) return;

            finished = true;

            device.removeEventListener(
                'advertisementreceived',
                onAdvEvent
            );

            abortController.abort();

            console.log(prefix, 'MAC_AUTO_FINISHED', {
                success: !!mac,
                reason
            });

            resolve(mac);
        };

        const onAdvEvent = (evt: Event) => {
            const advertisement = evt as BluetoothAdvertisingEvent;
            const manufacturerData = advertisement.manufacturerData;

            console.log(prefix, 'MAC_ADVERTISEMENT_RECEIVED', {
                manufacturerDataAvailable: !!manufacturerData,
                manufacturerIds: manufacturerData
                    ? Array.from(manufacturerData.keys())
                    : [],
                rssi: advertisement.rssi,
                txPower: advertisement.txPower
            });

            const mac = manufacturerData
                ? extractMAC(manufacturerData)
                : '';

            finish(mac || null, mac ? 'MAC_EXTRACTED' : 'NO_MAC_IN_ADVERTISEMENT');
        };

        device.addEventListener(
            'advertisementreceived',
            onAdvEvent
        );

        console.log(prefix, 'MAC_WATCH_ADVERTISEMENTS_START');

        device.watchAdvertisements({
            signal: abortController.signal
        }).then(() => {
            console.log(prefix, 'MAC_WATCH_ADVERTISEMENTS_STARTED');
        }).catch(error => {
            console.error(prefix, 'MAC_WATCH_ADVERTISEMENTS_FAILED', {
                name: error?.name,
                message: error?.message
            });

            finish(null, 'WATCH_FAILED');
        });

        setTimeout(() => {
            finish(null, 'ADVERTISEMENT_TIMEOUT_10_SECONDS');
        }, 10000);
    });
}

/**
 * Type representing function interface to implement custom MAC address provider
 * @param device Current BluetoothDevice selected by user.
 * @param isFallbackCall Flag indicating this is final and last resort call for MAC address.
 *                       If this flag is not set, custom provider can return null instead of MAC,
 *                       in such case library will try to read MAC automatically.
 */
type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

/**
 * Initiate new connection with the GAN Smart Cube device
 * @param customMacAddressProvider Optional custom provider for cube MAC address
 * @returns Object representing connection API and state
 */
async function connectGanCube(customMacAddressProvider?: MacAddressProvider): Promise<GanCubeConnection> {

    // Request user for the bluetooth device (popup selection dialog)
    var device: BluetoothDeviceWithMAC = await navigator.bluetooth.requestDevice(
        {
            filters: [
                { namePrefix: "GAN" },
                { namePrefix: "MG" },
                { namePrefix: "AiCube" }
            ],
            optionalServices: [def.GAN_GEN2_SERVICE, def.GAN_GEN3_SERVICE, def.GAN_GEN4_SERVICE],
            optionalManufacturerData: def.GAN_CIC_LIST
        }
    );


console.log('[GAN-BLE] MAC_RETRIEVAL_START');

var mac: string | null = null;

try {
    if (customMacAddressProvider) {
        console.log('[GAN-BLE] MAC_CUSTOM_PROVIDER_FIRST_CALL');

        mac = await customMacAddressProvider(device, false);

        console.log('[GAN-BLE] MAC_CUSTOM_PROVIDER_FIRST_RESULT', {
            success: !!mac
        });
    }

    if (!mac) {
        console.log('[GAN-BLE] MAC_AUTOMATIC_RETRIEVAL');

        mac = await autoRetrieveMacAddress(device);
    }

    if (!mac && customMacAddressProvider) {
        console.log('[GAN-BLE] MAC_MANUAL_FALLBACK_REQUESTED');

        mac = await customMacAddressProvider(device, true);

        console.log('[GAN-BLE] MAC_MANUAL_FALLBACK_RESULT', {
            success: !!mac
        });
    }

    if (!mac) {
        console.error('[GAN-BLE] MAC_RETRIEVAL_FAILED');

        throw new Error(
            'Unable to determine cube MAC address, connection is not possible!'
        );
    }

    console.log('[GAN-BLE] MAC_RETRIEVAL_SUCCESS', {
        source: 'retrieval-completed',
        validFormat: /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)
    });

} catch (error) {
    console.error('[GAN-BLE] MAC_RETRIEVAL_ERROR', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error)
    });

    throw error;
}

    if (!mac)
        throw new Error('Unable to determine cube MAC address, connection is not possible!');
    device.mac = mac;

    // Create encryption salt from MAC address bytes placed in reverse order
    var salt = new Uint8Array(device.mac.split(/[:-\s]+/).map((c) => parseInt(c, 16)).reverse());

    // Connect to GATT and get device primary services
console.log('[GAN-BLE] GATT_CONNECT_START');

console.log('[GAN-BLE] GATT_CONNECT_START', {
    macAvailable: !!device.mac,
    deviceName: device.name,
    gattAvailable: !!device.gatt
});
var gatt = await device.gatt!.connect();

console.log('[GAN-BLE] GATT_CONNECTED', {
    connected: gatt.connected,
    deviceName: device.name,
    deviceId: device.id,
    userAgent: navigator.userAgent
});

console.log('[GAN-BLE] SERVICE_DISCOVERY_START');

var discoveryStart = performance.now();

var services: BluetoothRemoteGATTService[];

try {
    services = await gatt.getPrimaryServices();

    console.log('[GAN-BLE] SERVICE_DISCOVERY_SUCCESS', {
        durationMs: Math.round(performance.now() - discoveryStart),
        count: services.length,
        uuids: services.map(service => service.uuid)
    });

    if (services.length === 0) {
        console.error('[GAN-BLE] EMPTY_SERVICE_LIST');
    }
} catch (error) {
    console.error('[GAN-BLE] SERVICE_DISCOVERY_FAILED', {
        error,
        connected: gatt.connected
    });

    throw error;
}

    var conn: GanCubeConnection | null = null;

    // Resolve type of connected cube device and setup appropriate encryption / protocol driver
    for (let service of services) {
        let serviceUUID = service.uuid.toLowerCase();
        if (serviceUUID == def.GAN_GEN2_SERVICE) {
            let commandCharacteristic = await service.getCharacteristic(def.GAN_GEN2_COMMAND_CHARACTERISTIC);
            let stateCharacteristic = await service.getCharacteristic(def.GAN_GEN2_STATE_CHARACTERISTIC);
            let key = device.name?.startsWith('AiCube') ? def.GAN_ENCRYPTION_KEYS[1] : def.GAN_ENCRYPTION_KEYS[0];
            let encrypter = new GanGen2CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
            let driver = new GanGen2ProtocolDriver();
            conn = await GanCubeClassicConnection.create(device, commandCharacteristic, stateCharacteristic, encrypter, driver);
            break;
        } else if (serviceUUID == def.GAN_GEN3_SERVICE) {
            let commandCharacteristic = await service.getCharacteristic(def.GAN_GEN3_COMMAND_CHARACTERISTIC);
            let stateCharacteristic = await service.getCharacteristic(def.GAN_GEN3_STATE_CHARACTERISTIC);
            let key = def.GAN_ENCRYPTION_KEYS[0];
            let encrypter = new GanGen3CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
            let driver = new GanGen3ProtocolDriver();
            conn = await GanCubeClassicConnection.create(device, commandCharacteristic, stateCharacteristic, encrypter, driver);
            break;
        } else if (serviceUUID == def.GAN_GEN4_SERVICE) {
            let commandCharacteristic = await service.getCharacteristic(def.GAN_GEN4_COMMAND_CHARACTERISTIC);
            let stateCharacteristic = await service.getCharacteristic(def.GAN_GEN4_STATE_CHARACTERISTIC);
            let key = def.GAN_ENCRYPTION_KEYS[0];
            let encrypter = new GanGen4CubeEncrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
            let driver = new GanGen4ProtocolDriver();
            conn = await GanCubeClassicConnection.create(device, commandCharacteristic, stateCharacteristic, encrypter, driver);
            break;
        }
    }

    if (!conn)
        throw new Error("Can't find target BLE services - wrong or unsupported cube device model");

    return conn;

}

export type {
    MacAddressProvider,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove
};

export {
    connectGanCube
};

