
import * as def from './gan-cube-definitions';
import {
    GanGen2CubeEncrypter,
    GanGen3CubeEncrypter,
    GanGen4CubeEncrypter
} from './gan-cube-encrypter';

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

const BLE = '[GAN-BLE]';

function log(event: string, details?: unknown): void {
    console.log(BLE, event, {
        timestamp: new Date().toISOString(),
        ...(details !== undefined ? { details } : {})
    });
}

function logError(event: string, error: unknown, details?: unknown): void {
    console.error(BLE, event, {
        timestamp: new Date().toISOString(),
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        details
    });
}

/** Diagnostic wrapper for all GATT characteristic discovery. */
async function debugGetCharacteristic(
    service: BluetoothRemoteGATTService,
    uuid: string
): Promise<BluetoothRemoteGATTCharacteristic> {
    log('CHARACTERISTIC_DISCOVERY_START', {
        serviceUUID: service.uuid,
        characteristicUUID: uuid
    });

    try {
        const characteristic = await service.getCharacteristic(uuid);

        log('CHARACTERISTIC_DISCOVERY_SUCCESS', {
            serviceUUID: service.uuid,
            characteristicUUID: characteristic.uuid,
            properties: {
                read: characteristic.properties.read,
                write: characteristic.properties.write,
                writeWithoutResponse: characteristic.properties.writeWithoutResponse,
                notify: characteristic.properties.notify,
                indicate: characteristic.properties.indicate
            }
        });

        return characteristic;
    } catch (error) {
        logError('CHARACTERISTIC_DISCOVERY_FAILED', error, {
            serviceUUID: service.uuid,
            characteristicUUID: uuid
        });
        throw error;
    }
}

/** Iterate over all known GAN cube CICs to find Manufacturer Specific Data */
function getManufacturerDataBytes(
    manufacturerData: BluetoothManufacturerData | DataView
): DataView | undefined {
    if (manufacturerData instanceof DataView) {
        return new DataView(
            manufacturerData.buffer.slice(2, 11)
        );
    }

    for (var id of def.GAN_CIC_LIST) {
        if (manufacturerData.has(id)) {
            return new DataView(
                manufacturerData.get(id)!.buffer.slice(0, 9)
            );
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
            mac.push(
                dataView.getUint8(dataView.byteLength - i)
                    .toString(16).toUpperCase().padStart(2, "0")
            );
        }
    }

    return mac.join(":");
}

/** Retrieve MAC address using Web Bluetooth advertisements. */
async function autoRetrieveMacAddress(
    device: BluetoothDevice
): Promise<string | null> {
    log('MAC_AUTO_START', {
        deviceName: device.name,
        deviceId: device.id,
        watchAdvertisementsAvailable:
            typeof device.watchAdvertisements === 'function'
    });

    if (typeof device.watchAdvertisements !== 'function') {
        log('MAC_WATCH_ADVERTISEMENTS_UNSUPPORTED');
        return null;
    }

    return new Promise<string | null>((resolve) => {
        const abortController = new AbortController();
        let finished = false;
        let timeout: ReturnType<typeof setTimeout>;

        const finish = (mac: string | null, reason: string) => {
            if (finished) return;

            finished = true;
            clearTimeout(timeout);

            device.removeEventListener(
                'advertisementreceived',
                onAdvEvent
            );

            abortController.abort();

            log('MAC_AUTO_FINISHED', {
                success: !!mac,
                reason
            });

            resolve(mac);
        };

        const onAdvEvent = (evt: Event) => {
            const advertisement = evt as BluetoothAdvertisingEvent;
            const manufacturerData = advertisement.manufacturerData;

            log('MAC_ADVERTISEMENT_RECEIVED', {
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

            finish(
                mac || null,
                mac ? 'MAC_EXTRACTED' : 'NO_MAC_IN_ADVERTISEMENT'
            );
        };

        device.addEventListener(
            'advertisementreceived',
            onAdvEvent
        );

        log('MAC_WATCH_ADVERTISEMENTS_START');

        device.watchAdvertisements({
            signal: abortController.signal
        }).then(() => {
            log('MAC_WATCH_ADVERTISEMENTS_STARTED');
        }).catch(error => {
            logError('MAC_WATCH_ADVERTISEMENTS_FAILED', error);
            finish(null, 'WATCH_FAILED');
        });

        timeout = setTimeout(() => {
            finish(null, 'ADVERTISEMENT_TIMEOUT_10_SECONDS');
        }, 10000);
    });
}

/**
 * Type representing function interface to implement custom MAC address provider.
 */
type MacAddressProvider = (
    device: BluetoothDevice,
    isFallbackCall?: boolean
) => Promise<string | null>;

/**
 * Initiate new connection with the GAN Smart Cube device.
 */
async function connectGanCube(
    customMacAddressProvider?: MacAddressProvider
): Promise<GanCubeConnection> {

    log('DEVICE_REQUEST_START', {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        bluetoothAvailable: !!navigator.bluetooth
    });

    var device: BluetoothDeviceWithMAC;

    try {
        device = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: "GAN" },
                { namePrefix: "MG" },
                { namePrefix: "AiCube" }
            ],
            optionalServices: [
                def.GAN_GEN2_SERVICE,
                def.GAN_GEN3_SERVICE,
                def.GAN_GEN4_SERVICE
            ],
            optionalManufacturerData: def.GAN_CIC_LIST
        });
    } catch (error) {
        logError('DEVICE_REQUEST_FAILED', error);
        throw error;
    }

    log('DEVICE_SELECTED', {
        name: device.name,
        id: device.id,
        gattAvailable: !!device.gatt
    });

    device.addEventListener('gattserverdisconnected', () => {
        log('GATT_DISCONNECTED', {
            name: device.name,
            id: device.id
        });
    });

    // MAC retrieval
    log('MAC_RETRIEVAL_START');

    var mac: string | null = null;

    try {
        if (customMacAddressProvider) {
            log('MAC_CUSTOM_PROVIDER_FIRST_CALL');

            mac = await customMacAddressProvider(device, false);

            log('MAC_CUSTOM_PROVIDER_FIRST_RESULT', {
                success: !!mac
            });
        }

        if (!mac) {
            log('MAC_AUTOMATIC_RETRIEVAL');
            mac = await autoRetrieveMacAddress(device);
        }

        if (!mac && customMacAddressProvider) {
            log('MAC_MANUAL_FALLBACK_REQUESTED');

            mac = await customMacAddressProvider(device, true);

            log('MAC_MANUAL_FALLBACK_RESULT', {
                success: !!mac
            });
        }

        if (!mac) {
            throw new Error(
                'Unable to determine cube MAC address, connection is not possible!'
            );
        }

        log('MAC_RETRIEVAL_SUCCESS', {
            validFormat: /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)
        });

    } catch (error) {
        logError('MAC_RETRIEVAL_ERROR', error);
        throw error;
    }

    device.mac = mac;

    // Create encryption salt from MAC address bytes placed in reverse order
    var salt = new Uint8Array(
        device.mac.split(/[:-\s]+/).map(
            (c) => parseInt(c, 16)
        ).reverse()
    );

    log('ENCRYPTION_SALT_CREATED', {
        byteLength: salt.length
    });

    // GATT connection
    log('GATT_CONNECT_START', {
        macAvailable: !!device.mac,
        deviceName: device.name,
        gattAvailable: !!device.gatt
    });

    var gatt: BluetoothRemoteGATTServer;

    try {
        gatt = await device.gatt!.connect();

        log('GATT_CONNECTED', {
            connected: gatt.connected
        });
    } catch (error) {
        logError('GATT_CONNECT_FAILED', error);
        throw error;
    }

    // Primary service discovery
    log('SERVICE_DISCOVERY_START');

    var discoveryStart = performance.now();
    var services: BluetoothRemoteGATTService[];

    try {
        services = await gatt.getPrimaryServices();

        log('SERVICE_DISCOVERY_SUCCESS', {
            durationMs: Math.round(performance.now() - discoveryStart),
            count: services.length,
            uuids: services.map(service => service.uuid),
            connected: gatt.connected
        });

        if (services.length === 0) {
            log('EMPTY_SERVICE_LIST');
        }
    } catch (error) {
        logError('SERVICE_DISCOVERY_FAILED', error, {
            connected: gatt.connected
        });
        throw error;
    }

    // GAN generation detection and initialization
    var conn: GanCubeConnection | null = null;

    log('SERVICE_PROCESSING_START', {
        serviceCount: services.length
    });

    try {
        for (let service of services) {
            let serviceUUID = service.uuid.toLowerCase();

            log('SERVICE_INSPECTED', {
                uuid: serviceUUID,
                matchesGen2: serviceUUID === def.GAN_GEN2_SERVICE,
                matchesGen3: serviceUUID === def.GAN_GEN3_SERVICE,
                matchesGen4: serviceUUID === def.GAN_GEN4_SERVICE
            });

            if (serviceUUID == def.GAN_GEN2_SERVICE) {
                log('GAN_PROTOCOL_MATCH', { generation: 2 });

                let commandCharacteristic =
                    await debugGetCharacteristic(
                        service,
                        def.GAN_GEN2_COMMAND_CHARACTERISTIC
                    );

                let stateCharacteristic =
                    await debugGetCharacteristic(
                        service,
                        def.GAN_GEN2_STATE_CHARACTERISTIC
                    );

                let key = device.name?.startsWith('AiCube')
                    ? def.GAN_ENCRYPTION_KEYS[1]
                    : def.GAN_ENCRYPTION_KEYS[0];

                let encrypter = new GanGen2CubeEncrypter(
                    new Uint8Array(key.key),
                    new Uint8Array(key.iv),
                    salt
                );

                let driver = new GanGen2ProtocolDriver();

                log('GAN_CONNECTION_CREATE_START', {
                    generation: 2
                });

                conn = await GanCubeClassicConnection.create(
                    device,
                    commandCharacteristic,
                    stateCharacteristic,
                    encrypter,
                    driver
                );

                log('GAN_CONNECTION_CREATE_SUCCESS', {
                    generation: 2
                });

                break;

            } else if (serviceUUID == def.GAN_GEN3_SERVICE) {
                log('GAN_PROTOCOL_MATCH', { generation: 3 });

                let commandCharacteristic =
                    await debugGetCharacteristic(
                        service,
                        def.GAN_GEN3_COMMAND_CHARACTERISTIC
                    );

                let stateCharacteristic =
                    await debugGetCharacteristic(
                        service,
                        def.GAN_GEN3_STATE_CHARACTERISTIC
                    );

                let key = def.GAN_ENCRYPTION_KEYS[0];

                let encrypter = new GanGen3CubeEncrypter(
                    new Uint8Array(key.key),
                    new Uint8Array(key.iv),
                    salt
                );

                let driver = new GanGen3ProtocolDriver();

                log('GAN_CONNECTION_CREATE_START', {
                    generation: 3
                });

                conn = await GanCubeClassicConnection.create(
                    device,
                    commandCharacteristic,
                    stateCharacteristic,
                    encrypter,
                    driver
                );

                log('GAN_CONNECTION_CREATE_SUCCESS', {
                    generation: 3
                });

                break;

            } else if (serviceUUID == def.GAN_GEN4_SERVICE) {
                log('GAN_PROTOCOL_MATCH', { generation: 4 });

                let commandCharacteristic =
                    await debugGetCharacteristic(
                        service,
                        def.GAN_GEN4_COMMAND_CHARACTERISTIC
                    );

                let stateCharacteristic =
                    await debugGetCharacteristic(
                        service,
                        def.GAN_GEN4_STATE_CHARACTERISTIC
                    );

                let key = def.GAN_ENCRYPTION_KEYS[0];

                let encrypter = new GanGen4CubeEncrypter(
                    new Uint8Array(key.key),
                    new Uint8Array(key.iv),
                    salt
                );

                let driver = new GanGen4ProtocolDriver();

                log('GAN_CONNECTION_CREATE_START', {
                    generation: 4
                });

                conn = await GanCubeClassicConnection.create(
                    device,
                    commandCharacteristic,
                    stateCharacteristic,
                    encrypter,
                    driver
                );

                log('GAN_CONNECTION_CREATE_SUCCESS', {
                    generation: 4
                });

                break;
            }
        }
    } catch (error) {
        logError('SERVICE_PROCESSING_FAILED', error, {
            services: services.map(service => service.uuid)
        });
        throw error;
    }

    if (!conn) {
        log('GAN_SERVICE_NOT_FOUND', {
            discoveredServices: services.map(service => service.uuid),
            expectedServices: [
                def.GAN_GEN2_SERVICE,
                def.GAN_GEN3_SERVICE,
                def.GAN_GEN4_SERVICE
            ]
        });

        throw new Error(
            "Can't find target BLE services - wrong or unsupported cube device model"
        );
    }

    log('GAN_CONNECTION_READY');

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

