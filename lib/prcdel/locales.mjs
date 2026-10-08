// Country formatting profiles for synthetic records: name pools, ID documents, voter-roll fields,
// plate formats, streets. Countries without a profile fall back to GENERIC with their own ISO code.
// All numbers produced from these are fictional; phones sit in the 555-01xx test block.

export const NAMES = {
  arabic: {
    male: ['Ahmed', 'Mohamed', 'Mahmoud', 'Omar', 'Youssef', 'Karim', 'Tarek', 'Hassan', 'Khaled', 'Mostafa', 'Amr', 'Sherif', 'Hani', 'Walid', 'Nabil', 'Samir', 'Ziad', 'Rami', 'Fadi', 'Bilal'],
    female: ['Fatma', 'Mona', 'Heba', 'Nour', 'Salma', 'Yasmin', 'Rania', 'Dina', 'Mariam', 'Laila', 'Hala', 'Reem', 'Lina', 'Sara', 'Aya', 'Nadia', 'Samira', 'Huda', 'Rasha', 'Maha'],
    family: ['El-Sayed', 'Abdel-Rahman', 'Mansour', 'Haddad', 'Khoury', 'Nassar', 'Saleh', 'Farouk', 'Hamdan', 'Darwish', 'Aziz', 'Shaker', 'Kamel', 'Fayad', 'Barakat', 'Hijazi', 'Saad', 'Rizk', 'Ghanem', 'Atallah'],
  },
  levant: {
    male: ['Elie', 'Georges', 'Charbel', 'Ziad', 'Rami', 'Fadi', 'Hussein', 'Ali', 'Wassim', 'Nadim', 'Karim', 'Joseph', 'Marwan', 'Samer', 'Tony', 'Bassam', 'Imad', 'Walid', 'Hadi', 'Rabih'],
    female: ['Rita', 'Maya', 'Nour', 'Zeina', 'Lara', 'Rasha', 'Mira', 'Carla', 'Hiba', 'Layal', 'Joelle', 'Nadine', 'Rola', 'Dalia', 'Ghada', 'Hanan', 'Rima', 'Sana', 'Yara', 'Lama'],
    family: ['Khoury', 'Haddad', 'Nassar', 'Gemayel', 'Aoun', 'Saab', 'Frem', 'Salameh', 'Hayek', 'Daher', 'Mrad', 'Chamoun', 'Harb', 'Tannous', 'Zein', 'Bazzi', 'Fakhoury', 'Karam', 'Sfeir', 'Moussa'],
  },
  southasian: {
    male: ['Muhammad', 'Ali', 'Usman', 'Bilal', 'Hamza', 'Imran', 'Faisal', 'Asad', 'Kamran', 'Zeeshan', 'Tariq', 'Adnan', 'Waqas', 'Shahid', 'Naveed', 'Rizwan', 'Junaid', 'Arif', 'Sohail', 'Nadeem'],
    female: ['Ayesha', 'Fatima', 'Sana', 'Hina', 'Amna', 'Maryam', 'Zainab', 'Rabia', 'Saima', 'Nida', 'Sadia', 'Iqra', 'Mahnoor', 'Shazia', 'Bushra', 'Farah', 'Uzma', 'Kiran', 'Nazia', 'Rubina'],
    family: ['Khan', 'Malik', 'Butt', 'Chaudhry', 'Qureshi', 'Sheikh', 'Siddiqui', 'Mirza', 'Awan', 'Raja', 'Hashmi', 'Abbasi', 'Rana', 'Javed', 'Iqbal', 'Baig', 'Gill', 'Shah', 'Bhatti', 'Anwar'],
  },
  eastafrican: {
    male: ['James', 'Peter', 'John', 'Brian', 'Kevin', 'Dennis', 'Collins', 'Samuel', 'Daniel', 'Joseph', 'Otieno', 'Kamau', 'Mwangi', 'Omondi', 'Kiprop', 'Wafula', 'Mutua', 'Njoroge', 'Juma', 'Baraka'],
    female: ['Mary', 'Grace', 'Faith', 'Mercy', 'Esther', 'Joyce', 'Ann', 'Wanjiru', 'Achieng', 'Nyambura', 'Akinyi', 'Chebet', 'Wambui', 'Atieno', 'Zawadi', 'Neema', 'Amani', 'Halima', 'Rehema', 'Imani'],
    family: ['Otieno', 'Kamau', 'Mwangi', 'Ochieng', 'Kiprotich', 'Wanjala', 'Mutua', 'Njoroge', 'Odhiambo', 'Kariuki', 'Chege', 'Kimani', 'Onyango', 'Barasa', 'Rotich', 'Wekesa', 'Maina', 'Owino', 'Langat', 'Mbugua'],
  },
  westafrican: {
    male: ['Chinedu', 'Emeka', 'Tunde', 'Kwame', 'Kofi', 'Yaw', 'Ibrahim', 'Musa', 'Segun', 'Olu', 'Femi', 'Ade', 'Kojo', 'Abdul', 'Uche', 'Chidi', 'Bola', 'Kunle', 'Nnamdi', 'Ifeanyi'],
    female: ['Ngozi', 'Chioma', 'Ama', 'Akosua', 'Funmi', 'Bisi', 'Aisha', 'Zainab', 'Efua', 'Adaeze', 'Yetunde', 'Nkechi', 'Abena', 'Kemi', 'Folake', 'Amaka', 'Halima', 'Esi', 'Adwoa', 'Titi'],
    family: ['Okafor', 'Adeyemi', 'Mensah', 'Owusu', 'Boateng', 'Bello', 'Okonkwo', 'Asante', 'Abubakar', 'Eze', 'Adebayo', 'Osei', 'Nwosu', 'Danjuma', 'Afolabi', 'Appiah', 'Obi', 'Lawal', 'Agyeman', 'Okeke'],
  },
  persian: {
    male: ['Reza', 'Ali', 'Mehdi', 'Hossein', 'Amir', 'Saeed', 'Mohsen', 'Hamid', 'Babak', 'Kian', 'Arash', 'Farhad', 'Majid', 'Behrouz', 'Davood', 'Navid', 'Pouya', 'Kaveh', 'Omid', 'Siavash'],
    female: ['Maryam', 'Zahra', 'Fatemeh', 'Sara', 'Neda', 'Leila', 'Shirin', 'Parisa', 'Mahsa', 'Roya', 'Nazanin', 'Azadeh', 'Mina', 'Elham', 'Samira', 'Golnar', 'Narges', 'Yasaman', 'Bahar', 'Setareh'],
    family: ['Hosseini', 'Rezaei', 'Ahmadi', 'Mohammadi', 'Karimi', 'Moradi', 'Jafari', 'Rahimi', 'Kazemi', 'Sadeghi', 'Ghorbani', 'Mousavi', 'Najafi', 'Tehrani', 'Akbari', 'Hashemi', 'Ebrahimi', 'Shahbazi', 'Amini', 'Nouri'],
  },
  turkic: {
    male: ['Aziz', 'Rustam', 'Timur', 'Bekzod', 'Sardor', 'Jasur', 'Murat', 'Emre', 'Ahmet', 'Mehmet', 'Nurlan', 'Askar', 'Daniyar', 'Aibek', 'Erlan', 'Kanat', 'Ruslan', 'Farrukh', 'Otabek', 'Ilhom'],
    female: ['Dilnoza', 'Gulnara', 'Aigerim', 'Madina', 'Zarina', 'Elif', 'Zeynep', 'Ayşe', 'Aliya', 'Kamila', 'Nigora', 'Saule', 'Dinara', 'Malika', 'Shahnoza', 'Leyla', 'Asel', 'Aizhan', 'Nilufar', 'Sevara'],
    family: ['Karimov', 'Usmanov', 'Rakhimov', 'Nazarbayev', 'Tursunov', 'Yilmaz', 'Kaya', 'Demir', 'Sultanov', 'Abdullaev', 'Ismailov', 'Aliyev', 'Nurmagambetov', 'Seitkali', 'Zhakupov', 'Mirzaev', 'Kurbanov', 'Yusupov', 'Ergashev', 'Toshmatov'],
  },
  malay: {
    male: ['Ahmad', 'Muhammad', 'Hafiz', 'Faizal', 'Azman', 'Rizal', 'Budi', 'Agus', 'Dewa', 'Hendra', 'Iwan', 'Joko', 'Sokha', 'Dara', 'Vannak', 'Rithy', 'Bopha', 'Sophal', 'Arif', 'Syafiq'],
    female: ['Siti', 'Nur', 'Aisyah', 'Farah', 'Dewi', 'Putri', 'Ayu', 'Rina', 'Sreymom', 'Chantha', 'Sokunthea', 'Lina', 'Intan', 'Wulan', 'Nurul', 'Aminah', 'Zarina', 'Melati', 'Sari', 'Kanha'],
    family: ['Abdullah', 'Ismail', 'Rahman', 'Hassan', 'Santoso', 'Wijaya', 'Kusuma', 'Pratama', 'Sok', 'Chan', 'Heng', 'Lim', 'Tan', 'Yusof', 'Hamid', 'Saputra', 'Hidayat', 'Nugroho', 'Chea', 'Kong'],
  },
  latin: {
    male: ['José', 'Juan', 'Carlos', 'Luis', 'Miguel', 'Jorge', 'Pedro', 'Andrés', 'Diego', 'Rafael', 'João', 'Paulo', 'Marcos', 'Felipe', 'Ricardo', 'Fernando', 'Alejandro', 'Gustavo', 'Mateus', 'Rodrigo'],
    female: ['María', 'Ana', 'Lucía', 'Camila', 'Valentina', 'Gabriela', 'Fernanda', 'Juliana', 'Paula', 'Daniela', 'Isabela', 'Beatriz', 'Carolina', 'Mariana', 'Sofía', 'Patricia', 'Adriana', 'Larissa', 'Renata', 'Claudia'],
    family: ['García', 'Rodríguez', 'Martínez', 'López', 'González', 'Pérez', 'Silva', 'Santos', 'Oliveira', 'Souza', 'Ramírez', 'Torres', 'Flores', 'Rojas', 'Castro', 'Vargas', 'Ferreira', 'Almeida', 'Mendoza', 'Herrera'],
  },
  slavic: {
    male: ['Ivan', 'Dmitri', 'Nikola', 'Marko', 'Stefan', 'Aleksandar', 'Milan', 'Petar', 'László', 'Gábor', 'Zoltán', 'Andrei', 'Pavel', 'Sergei', 'Bogdan', 'Dušan', 'Tomasz', 'Piotr', 'Viktor', 'Oleg'],
    female: ['Ana', 'Jelena', 'Milica', 'Ivana', 'Katalin', 'Eszter', 'Olga', 'Natalia', 'Elena', 'Marija', 'Anna', 'Svetlana', 'Dragana', 'Zsófia', 'Irina', 'Tatiana', 'Agnieszka', 'Vesna', 'Nina', 'Daria'],
    family: ['Petrović', 'Jovanović', 'Nikolić', 'Marković', 'Nagy', 'Kovács', 'Tóth', 'Ivanov', 'Popov', 'Kuznetsov', 'Horváth', 'Szabó', 'Novak', 'Kowalski', 'Đorđević', 'Stojanović', 'Volkov', 'Pavlović', 'Lukić', 'Varga'],
  },
  russian: {
    male: ['Aleksandr', 'Dmitry', 'Sergei', 'Andrei', 'Alexei', 'Mikhail', 'Ivan', 'Nikolai', 'Pavel', 'Vladimir', 'Yuri', 'Oleg', 'Igor', 'Maxim', 'Konstantin', 'Roman', 'Viktor', 'Artem'],
    female: ['Anna', 'Elena', 'Olga', 'Natalia', 'Irina', 'Tatiana', 'Svetlana', 'Ekaterina', 'Maria', 'Yulia', 'Daria', 'Ksenia', 'Marina', 'Anastasia', 'Polina', 'Vera'],
    family: ['Ivanov', 'Smirnov', 'Kuznetsov', 'Popov', 'Sokolov', 'Lebedev', 'Kozlov', 'Novikov', 'Morozov', 'Volkov', 'Solovyov', 'Vasiliev', 'Zaitsev', 'Pavlov', 'Semyonov', 'Golubev', 'Vinogradov', 'Bogdanov', 'Orlov', 'Belyaev'],
  },
  western: {
    male: ['James', 'Michael', 'David', 'Robert', 'Daniel', 'Thomas', 'Mark', 'Paul', 'Andrew', 'Kevin', 'Brian', 'Eric', 'Ryan', 'Jason', 'Matthew', 'Steven', 'Lukas', 'Pierre', 'Hans', 'Luca'],
    female: ['Mary', 'Jennifer', 'Linda', 'Sarah', 'Emily', 'Laura', 'Rachel', 'Megan', 'Anna', 'Claire', 'Sophie', 'Julia', 'Emma', 'Hannah', 'Katherine', 'Amanda', 'Nicole', 'Lisa', 'Marie', 'Chiara'],
    family: ['Smith', 'Johnson', 'Brown', 'Miller', 'Wilson', 'Taylor', 'Anderson', 'Clark', 'Walker', 'Hall', 'Young', 'King', 'Müller', 'Schmidt', 'Martin', 'Bernard', 'Rossi', 'Bianchi', 'Murphy', 'Kelly'],
  },
  southasianHindu: {
    male: ['Rahul', 'Amit', 'Rohan', 'Vikram', 'Suresh', 'Arjun', 'Rajesh', 'Anil', 'Sanjay', 'Deepak', 'Rakib', 'Tanvir', 'Sabbir', 'Bikash', 'Prakash', 'Ramesh', 'Nirmal', 'Kiran', 'Ashok', 'Manoj'],
    female: ['Priya', 'Anjali', 'Neha', 'Pooja', 'Kavita', 'Sunita', 'Nusrat', 'Tahmina', 'Sabina', 'Sita', 'Gita', 'Lakshmi', 'Meena', 'Shreya', 'Ritu', 'Divya', 'Asha', 'Rekha', 'Nasrin', 'Shirin'],
    family: ['Sharma', 'Verma', 'Gupta', 'Singh', 'Patel', 'Rahman', 'Hossain', 'Ahmed', 'Islam', 'Shrestha', 'Thapa', 'Gurung', 'Perera', 'Fernando', 'Silva', 'Reddy', 'Nair', 'Das', 'Chowdhury', 'Karki'],
  },
  chinese: {
    male: ['Wei', 'Jun', 'Hao', 'Lei', 'Tao', 'Peng', 'Bin', 'Qiang', 'Gang', 'Jian', 'Yong', 'Ming', 'Zhiwei', 'Haoran', 'Yifan', 'Zihao', 'Jiahao', 'Tianyu', 'Xiaolong', 'Chenguang'],
    female: ['Fang', 'Jing', 'Li', 'Ying', 'Xiu', 'Yan', 'Hui', 'Lan', 'Mei', 'Xin', 'Yuxi', 'Shuang', 'Xiaoyu', 'Yuting', 'Jiayi', 'Ruoxi', 'Siqi', 'Wenjing', 'Lili', 'Qian'],
    family: ['Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Zhao', 'Huang', 'Zhou', 'Wu', 'Xu', 'Sun', 'Hu', 'Zhu', 'Gao', 'Lin', 'He', 'Guo', 'Ma', 'Luo'],
  },
};

const STREETS = {
  arabic: ['Tahrir St', 'Al-Nasr Rd', 'Corniche El-Nil', 'Salah Salem St', '26th of July St', 'Abbas El-Akkad St', 'Makram Ebeid St', 'Al-Haram St', 'King Fahd Rd', 'Olaya St', 'Al-Rashid St'],
  levant: ['Hamra St', 'Bliss St', 'Rue Monot', 'Rue Gouraud', 'Mar Elias St', 'Verdun St', 'Charles Helou Ave', 'Rue Pasteur', 'Sassine Sq', 'Airport Rd'],
  southasian: ['Jinnah Ave', 'Blue Area', 'F-7 Markaz', 'Shahrah-e-Faisal', 'Mall Rd', 'G-9/4 St 12', 'Margalla Rd', 'Club Rd', 'Kashmir Hwy', 'I-8 Markaz'],
  eastafrican: ['Moi Ave', 'Kenyatta Ave', 'Ngong Rd', 'Waiyaki Way', 'Kimathi St', 'Haile Selassie Ave', 'Mombasa Rd', 'Langata Rd', 'Bole Rd', 'Kampala Rd'],
  westafrican: ['Adeola Odeku St', 'Ahmadu Bello Way', 'Herbert Macaulay Way', 'Oxford St', 'Ring Rd', 'Independence Ave', 'Awolowo Rd', 'Liberation Rd'],
  persian: ['Valiasr St', 'Enghelab St', 'Azadi St', 'Shariati St', 'Motahari St', 'Jordan St', 'Mirdamad Blvd'],
  turkic: ['Amir Temur St', 'Navoi Ave', 'Abay Ave', 'Istiklal Cd', 'Atatürk Blvd', 'Chuy Ave', 'Rudaki Ave', 'Dostyk Ave'],
  malay: ['Jalan Sudirman', 'Jalan Thamrin', 'Jalan Ampang', 'Jalan Bukit Bintang', 'Norodom Blvd', 'Monivong Blvd', 'Jalan Gatot Subroto', 'Sihanouk Blvd'],
  latin: ['Av. Paulista', 'Av. Brasil', 'Calle 72', 'Av. Arequipa', 'Av. Corrientes', 'Rua Augusta', 'Av. Reforma', 'Av. Libertador'],
  slavic: ['Knez Mihailova', 'Andrássy út', 'Váci utca', 'Nevsky Prospekt', 'Tverskaya St', 'Bulevar Kralja Aleksandra', 'Marszałkowska'],
  western: ['Main St', 'High St', 'Market St', 'Park Ave', 'King St', 'Church Rd', 'Station Rd', 'Elm St'],
  southasianHindu: ['MG Road', 'Janpath', 'Gulshan Ave', 'Durbar Marg', 'Galle Rd', 'Mirpur Rd', 'Connaught Pl', 'Baneshwor Rd'],
  chinese: ['Chang\'an Ave', 'Jianguo Rd', 'Zhongshan Rd', 'Nanjing Rd', 'Renmin Rd', 'Jiefang Rd'],
};

const D = (r, n) => Array.from({ length: n }, () => r.int(0, 9)).join('');

// id(r, person) → { type, number }
const ID = {
  EG: r => ({ type: 'Egyptian National ID', number: `2${D(r, 6)}${String(r.int(1, 35)).padStart(2, '0')}${D(r, 4)}${D(r, 1)}` }),
  PK: r => ({ type: 'CNIC', number: `${r.pick(['35202', '61101', '42101', '37405', '17301'])}-${D(r, 7)}-${r.int(1, 9)}` }),
  LB: r => ({ type: 'Lebanese ID Card', number: `000${D(r, 9)}` }),
  KE: r => ({ type: 'Kenyan National ID', number: `${r.int(2, 3)}${D(r, 7)}` }),
  SA: r => ({ type: 'Saudi National ID', number: `1${D(r, 9)}` }),
  AE: r => ({ type: 'Emirates ID', number: `784-${r.int(1960, 2002)}-${D(r, 7)}-${r.int(1, 9)}` }),
  IR: r => ({ type: 'Iranian National Code', number: `${D(r, 3)}-${D(r, 6)}-${D(r, 1)}` }),
  IQ: r => ({ type: 'Iraqi Unified National Card', number: `1${D(r, 11)}` }),
  JO: r => ({ type: 'Jordanian National Number', number: `9${D(r, 9)}` }),
  NG: r => ({ type: 'NIN', number: D(r, 11) }),
  GH: r => ({ type: 'Ghana Card', number: `GHA-${D(r, 9)}-${r.int(1, 9)}` }),
  ET: r => ({ type: 'Fayda ID', number: D(r, 12) }),
  IN: r => ({ type: 'Aadhaar (masked)', number: `XXXX-XXXX-${D(r, 4)}` }),
  BD: r => ({ type: 'Bangladesh NID', number: D(r, 10) }),
  US: r => ({ type: 'Driver License', number: `D${D(r, 3)}-${D(r, 4)}-${D(r, 4)}` }),
  BR: r => ({ type: 'CPF', number: `${D(r, 3)}.${D(r, 3)}.${D(r, 3)}-${D(r, 2)}` }),
  TR: r => ({ type: 'T.C. Kimlik No', number: `${r.int(1, 9)}${D(r, 10)}` }),
  UZ: r => ({ type: 'Uzbek ID (PINFL)', number: `${r.int(3, 6)}${D(r, 13)}` }),
  KZ: r => ({ type: 'Kazakh IIN', number: D(r, 12) }),
  ID: r => ({ type: 'NIK (KTP)', number: `31${D(r, 14)}` }),
  MY: r => ({ type: 'MyKad', number: `${D(r, 6)}-${D(r, 2)}-${D(r, 4)}` }),
  KH: r => ({ type: 'Khmer ID Card', number: D(r, 9) }),
  RS: r => ({ type: 'JMBG', number: D(r, 13) }),
  HU: r => ({ type: 'Személyi igazolvány', number: `${D(r, 6)}${String.fromCharCode(65 + r.int(0, 25))}${String.fromCharCode(65 + r.int(0, 25))}` }),
};

const AR = '٠١٢٣٤٥٦٧٨٩';
const arDigits = s => s.replace(/\d/g, d => AR[d]);
const LET = n => r => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPRSTUVWXYZ'[r.int(0, 22)]).join('');
const PLATE = {
  EG: r => { const ar = ['أ', 'ب', 'ج', 'د', 'ر', 'س', 'ص', 'ط', 'ع', 'ف', 'ق', 'ل', 'م', 'ن', 'هـ', 'و', 'ى']; const l = [r.pick(ar), r.pick(ar), r.pick(ar)]; const n = D(r, 4); return `${l.join(' ')} ${arDigits(n)} (${n})`; },
  LB: r => `${r.pick(['B', 'G', 'M', 'N', 'O', 'T', 'Z'])} ${D(r, 6)}`,
  PK: r => r.pick([`ICT ${LET(2)(r)}-${D(r, 3)}`, `LE${LET(1)(r)}-${r.int(10, 25)}-${D(r, 4)}`, `${LET(3)(r)}-${D(r, 3)} (Sindh)`]),
  KE: r => `K${LET(2)(r)} ${D(r, 3)}${LET(1)(r)}`,
  SA: r => `${D(r, 4)} ${LET(3)(r)}`,
  AE: r => `${r.pick(['Dubai', 'Abu Dhabi'])} ${LET(1)(r)} ${D(r, 5)}`,
  IR: r => `${D(r, 2)} ${r.pick(['ب', 'ج', 'د', 'س', 'ص', 'ط', 'ق', 'ل', 'م', 'ن', 'و', 'ه', 'ی'])} ${D(r, 3)} - ${D(r, 2)}`,
  NG: r => `${LET(3)(r)}-${D(r, 3)}${LET(2)(r)}`,
  US: r => `${D(r, 1)}${LET(3)(r)}${D(r, 3)}`,
  BR: r => `${LET(3)(r)}${D(r, 1)}${LET(1)(r)}${D(r, 2)}`,
  TR: r => `${r.int(1, 81).toString().padStart(2, '0')} ${LET(2)(r)} ${D(r, 3)}`,
  RS: r => `BG ${D(r, 3)}-${LET(2)(r)}`,
  HU: r => `${LET(4)(r)}-${D(r, 3)}`,
  KH: r => `PP ${r.int(1, 3)}${LET(1)(r)}-${D(r, 4)}`,
  ID: r => `B ${D(r, 4)} ${LET(3)(r)}`,
  MY: r => `W${LET(2)(r)} ${D(r, 4)}`,
  UZ: r => `01 ${LET(1)(r)} ${D(r, 3)} ${LET(2)(r)}`,
  KZ: r => `${D(r, 3)} ${LET(3)(r)} 01`,
  IN: r => `DL ${r.int(1, 13).toString().padStart(2, '0')} ${LET(2)(r)} ${D(r, 4)}`,
};

const PHONE_CC = { EG: '20', LB: '961', PK: '92', KE: '254', SA: '966', AE: '971', IR: '98', IQ: '964', JO: '962', SY: '963', TR: '90', IL: '972', QA: '974', KW: '965', OM: '968', BH: '973',
  NG: '234', GH: '233', ET: '251', UG: '256', TZ: '255', RW: '250', ZA: '27', ZM: '260', ZW: '263', DZ: '213', MA: '212', TN: '216', LY: '218', SD: '249', DJ: '253', SN: '221', CI: '225', AO: '244',
  IN: '91', BD: '880', NP: '977', LK: '94', AF: '93', UZ: '998', KZ: '7', KG: '996', TJ: '992', TM: '993', AZ: '994', GE: '995', AM: '374', MN: '976', RU: '7', BY: '375', UA: '380',
  ID: '62', MY: '60', KH: '855', TH: '66', VN: '84', LA: '856', MM: '95', PH: '63', SG: '65', JP: '81', KR: '82', AU: '61', NZ: '64', FJ: '679', SB: '677', PG: '675',
  US: '1', CA: '1', MX: '52', BR: '55', AR: '54', CL: '56', PE: '51', CO: '57', VE: '58', EC: '593', BO: '591', CU: '53', NI: '505', PA: '507',
  GB: '44', FR: '33', DE: '49', IT: '39', ES: '34', PT: '351', GR: '30', RS: '381', HU: '36', PL: '48', CZ: '420', BE: '32', NL: '31', CH: '41', AT: '43', SE: '46', NO: '47', FI: '358', IE: '353', CN: '86' };

const STYLE = { EG: 'arabic', SA: 'arabic', AE: 'arabic', QA: 'arabic', KW: 'arabic', OM: 'arabic', BH: 'arabic', IQ: 'arabic', LY: 'arabic', SD: 'arabic', DZ: 'arabic', MA: 'arabic', TN: 'arabic', YE: 'arabic', DJ: 'arabic', MR: 'arabic',
  LB: 'levant', SY: 'levant', JO: 'levant', PS: 'levant', IL: 'western', PK: 'southasian', AF: 'southasian', IN: 'southasianHindu', BD: 'southasianHindu', NP: 'southasianHindu', LK: 'southasianHindu', MV: 'southasian',
  KE: 'eastafrican', ET: 'eastafrican', UG: 'eastafrican', TZ: 'eastafrican', RW: 'eastafrican', SS: 'eastafrican', SO: 'eastafrican', ER: 'eastafrican', ZM: 'eastafrican', ZW: 'eastafrican', MW: 'eastafrican', MZ: 'eastafrican', ZA: 'eastafrican', NA: 'eastafrican', BW: 'eastafrican', AO: 'westafrican', CD: 'westafrican', CG: 'westafrican',
  NG: 'westafrican', GH: 'westafrican', CI: 'westafrican', BJ: 'westafrican', TG: 'westafrican', SN: 'westafrican', ML: 'westafrican', NE: 'westafrican', BF: 'westafrican', GN: 'westafrican', SL: 'westafrican', LR: 'westafrican', CM: 'westafrican', GA: 'westafrican', TD: 'westafrican', CF: 'westafrican',
  IR: 'persian', TJ: 'persian', TR: 'turkic', UZ: 'turkic', KZ: 'turkic', KG: 'turkic', TM: 'turkic', AZ: 'turkic', ID: 'malay', MY: 'malay', KH: 'malay', BN: 'malay', TL: 'malay', PH: 'malay', TH: 'malay', LA: 'malay', VN: 'malay', MM: 'malay',
  BR: 'latin', AR: 'latin', CL: 'latin', PE: 'latin', CO: 'latin', VE: 'latin', EC: 'latin', BO: 'latin', UY: 'latin', PY: 'latin', MX: 'latin', CU: 'latin', NI: 'latin', PA: 'latin', CR: 'latin', HN: 'latin', SV: 'latin', GT: 'latin', DO: 'latin', ES: 'latin', PT: 'latin',
  RS: 'slavic', HU: 'slavic', RU: 'slavic', BY: 'slavic', UA: 'slavic', PL: 'slavic', BG: 'slavic', RO: 'slavic', HR: 'slavic', BA: 'slavic', ME: 'slavic', MK: 'slavic', SK: 'slavic', CZ: 'slavic', SI: 'slavic', MD: 'slavic', GE: 'slavic', AM: 'slavic', MN: 'turkic', CN: 'chinese' };

// Voter-roll conventions: fatherMother → roll lists father's and mother's names to separate
// common names (most Muslim-majority rolls); familyRegistry → Lebanon's sijil (family register) number.
const VOTER = {
  LB: { authority: 'Ministry of Interior & Municipalities — Voter Lists', fatherMother: true, familyRegistry: true, motherMaiden: true },
  EG: { authority: 'National Election Authority', fatherMother: true }, PK: { authority: 'Election Commission of Pakistan', fatherMother: true, husbandOrFather: true },
  IQ: { authority: 'IHEC Voter Registry', fatherMother: true, grandfather: true }, JO: { authority: 'Independent Election Commission', fatherMother: true }, SY: { authority: 'Higher Judicial Committee for Elections', fatherMother: true, familyRegistry: true },
  SA: { authority: 'Municipal Elections Registry', fatherMother: true }, IR: { authority: 'Ministry of Interior Election HQ', fatherMother: true }, AF: { authority: 'Independent Election Commission', fatherMother: true },
  BD: { authority: 'Bangladesh Election Commission', fatherMother: true }, LY: { authority: 'HNEC Voter Registry', fatherMother: true }, DZ: { authority: 'ANIE Voter Lists', fatherMother: true },
  MA: { authority: 'Listes électorales générales', fatherMother: true }, TN: { authority: 'ISIE Voter Registry', fatherMother: true }, SD: { authority: 'National Elections Commission', fatherMother: true },
  KE: { authority: 'IEBC Register of Voters' }, NG: { authority: 'INEC Voter Register' }, GH: { authority: 'Electoral Commission of Ghana' }, IN: { authority: 'Election Commission of India', husbandOrFather: true },
  ID: { authority: 'KPU Daftar Pemilih Tetap' }, MY: { authority: 'SPR Daftar Pemilih' }, TR: { authority: 'YSK Seçmen Kütüğü' }, BR: { authority: 'TSE Cadastro Eleitoral' }, US: { authority: 'County Voter Registration' },
};

export function locale(iso2) {
  const style = STYLE[iso2] || 'western';
  return {
    iso2, style, names: NAMES[style], streets: STREETS[style] || STREETS.western,
    cc: PHONE_CC[iso2] || '999',
    id: ID[iso2] || (r => ({ type: 'National ID', number: `${iso2}${D(r, 9)}` })),
    plate: PLATE[iso2] || (r => `${LET(2)(r)} ${D(r, 4)}`),
    voter: VOTER[iso2] || { authority: 'National Voter Register' },
  };
}
